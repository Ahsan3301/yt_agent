"""
editor.py — Video Assembly Module
Uses ffmpeg to:
  1. Loop/trim stock clips to match voiceover duration
  2. Overlay voiceover audio on video
  3. Mix in background music at low volume
  4. Burn in captions (ASS subtitle format)
  5. Output a final YouTube Shorts-ready MP4 (1080x1920 vertical)

Requires ffmpeg installed: sudo apt install ffmpeg  (or choco install ffmpeg on Windows)
"""
import os
import re
import random
import logging
import subprocess
import json
from pathlib import Path
from dotenv import load_dotenv

from modules.config import load_settings

load_dotenv()
log = logging.getLogger(__name__)

# YouTube Shorts format
OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
OUTPUT_FPS = 30


# ── GPU encoder detection ────────────────────────────────────
# Colab's T4 has NVENC (NVIDIA's hardware encoder). Using it instead of
# libx264 cuts wall-clock for the encoding stages by 5-10×. We probe once
# at import time so the per-segment ffmpeg calls don't pay the detection
# cost. Force off via FFMPEG_FORCE_CPU=1 for debugging.
def _detect_nvenc() -> bool:
    if os.getenv("FFMPEG_FORCE_CPU", "").lower() in ("1", "true", "yes"):
        return False
    # 1. Does the ffmpeg binary support h264_nvenc?
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5
        )
        if "h264_nvenc" not in (r.stdout or ""):
            return False
    except Exception:
        return False
    # 2. Is there actually an NVIDIA GPU we can talk to?
    try:
        r = subprocess.run(
            ["nvidia-smi", "-L"], capture_output=True, text=True, timeout=5
        )
        if r.returncode != 0 or "GPU" not in (r.stdout or ""):
            return False
    except Exception:
        return False
    # 3. Smoke test: can NVENC actually encode? Some systems have the
    #    encoder compiled in but no working driver/library.
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1",
             "-c:v", "h264_nvenc", "-f", "null", "-"],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


_USE_NVENC = _detect_nvenc()
log.info(f"video encoder: {'h264_nvenc (GPU)' if _USE_NVENC else 'libx264 (CPU)'}")


# ── GPU-native renderer detection ───────────────────────────────
# The optional editor_gpu module needs torch + decord + PyAV. If any
# dep is missing the import fails and we silently stay on the ffmpeg
# path — that's the contract for HF Space / other CPU workers without
# the requirements-gpu.txt extras.
try:
    from modules import editor_gpu  # noqa: F401
    _HAS_GPU_RENDERER = True
    log.info("editor_gpu: available")
except Exception as e:
    editor_gpu = None  # type: ignore[assignment]
    _HAS_GPU_RENDERER = False
    log.info(f"editor_gpu: unavailable ({e.__class__.__name__}); using ffmpeg path")


_GPU_DISABLED_FOR_SESSION = False


def _mark_gpu_broken(reason: str) -> None:
    """One-strike-out latch: after the first CUDA/NVENC failure we skip
    editor_gpu for the rest of the process lifetime. Prevents Kaggle
    from spending seconds per shot logging "no kernel image is available
    for execution on the device" for every segment. The ffmpeg path is
    the same quality; only difference is speed."""
    global _GPU_DISABLED_FOR_SESSION
    if not _GPU_DISABLED_FOR_SESSION:
        _GPU_DISABLED_FOR_SESSION = True
        log.warning(
            f"editor_gpu: disabling GPU renderer for the rest of this process "
            f"after first failure ({reason}). All remaining segments render "
            f"via ffmpeg — same output, slower per-segment."
        )


def _use_gpu_renderer() -> bool:
    """True iff per-segment GPU path should be tried for this call.

    Four gates:
      1. The editor_gpu module imported (torch + decord + av present).
      2. CUDA is reachable AT CALL TIME (not just at import).
      3. The user hasn't forced "cpu" via settings.video.render_pipeline.
      4. GPU hasn't errored earlier in this process (one-strike-out).
    """
    if not _HAS_GPU_RENDERER:
        return False
    if _GPU_DISABLED_FOR_SESSION:
        return False
    try:
        if not editor_gpu.is_available():
            return False
    except Exception:
        return False
    mode = (load_settings().get("video", {}) or {}).get("render_pipeline", "auto")
    return mode in ("auto", "gpu")


def _vcodec_args(crf: str = "23", preset_cpu: str = "fast") -> list[str]:
    """Return the -c:v ... block for a YouTube Shorts encode.

    On GPU (NVENC): uses VBR with a constant-quality target. p4 is a
    balanced preset; quality is comparable to libx264 -crf at the same
    cq value, but typically 5-10× faster on a T4.
    On CPU (libx264): the original args.
    """
    if _USE_NVENC:
        # NVENC: p1=fastest, p7=slowest. p4 = balanced.
        # -rc vbr -cq <n> mirrors CRF semantics.
        return [
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", str(crf),
            "-b:v", "0",      # let cq drive the bitrate
        ]
    return ["-c:v", "libx264", "-preset", preset_cpu, "-crf", str(crf)]


# Track the currently-running ffmpeg Popen so jobs.cancel() can kill it
# instead of waiting for a multi-minute encode to finish.
_active_proc: subprocess.Popen | None = None
_active_lock = __import__("threading").Lock()


def terminate_active():
    """Best-effort kill the running ffmpeg, if any. Safe to call from
    another thread."""
    global _active_proc
    with _active_lock:
        p = _active_proc
    if p is None:
        return False
    try:
        p.terminate()
        try: p.wait(timeout=2)
        except Exception: p.kill()
        return True
    except Exception:
        return False


def run_ffmpeg(args, desc="ffmpeg", cwd=None):
    """Run an ffmpeg command, raise on failure.

    cwd lets us run a command from inside a specific folder — used for the
    final assembly step so the `ass=` filter can reference the caption file
    by a bare relative filename instead of a full Windows path. That avoids
    ffmpeg's filtergraph colon-escaping bug entirely (drive-letter colons in
    paths like C:\\Users\\... get misparsed by the ass/subtitles filter even
    when backslash-escaped).

    On failure we log the command, stdout, and stderr — `-loglevel warning`
    is selected so we capture real diagnostics if ffmpeg dies. Previously
    `-loglevel error` suppressed everything and produced empty-stderr crashes
    that were impossible to debug.

    Cancellation: before launching, we check run_state for a cancel
    request; if set, we raise Cancelled without running. The Popen is
    tracked globally so terminate_active() can kill it mid-encode.
    """
    # Lazy import to avoid a startup-time cycle with modules.config.
    from modules import run_state
    run_state.check_cancel()

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning"] + args
    log.info(f"Running {desc}: {' '.join(cmd[:6])}...")

    global _active_proc
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=cwd, text=True, encoding="utf-8", errors="replace",
    )
    with _active_lock:
        _active_proc = proc
    try:
        stdout, stderr = proc.communicate()
    finally:
        with _active_lock:
            if _active_proc is proc:
                _active_proc = None

    if proc.returncode != 0:
        # If we were cancelled mid-encode, surface that as Cancelled
        # rather than a generic ffmpeg error.
        if run_state.cancellation_requested():
            raise run_state.Cancelled("ffmpeg terminated by user cancel")
        stderr_tail = (stderr or "")[-1500:].strip() or "(empty)"
        stdout_tail = (stdout or "")[-500:].strip()
        log.error(f"ffmpeg [{desc}] failed (exit {proc.returncode})")
        log.error(f"  cmd: {' '.join(cmd)}")
        log.error(f"  stderr: {stderr_tail}")
        if stdout_tail:
            log.error(f"  stdout: {stdout_tail}")
        raise RuntimeError(f"ffmpeg [{desc}] failed: {stderr_tail[-300:]}")
    # Stash captured output on a Result-like for the success path below.
    class _R:
        pass
    result = _R()
    result.returncode = proc.returncode
    result.stdout = stdout
    result.stderr = stderr
    if result.stderr and result.stderr.strip():
        log.debug(f"ffmpeg [{desc}] stderr: {result.stderr.strip()[-300:]}")
    return True


def get_audio_duration(audio_path):
    """Get duration of an audio file in seconds using ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json", audio_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def get_video_duration(video_path):
    """Get duration of a video file in seconds using ffprobe. Returns 0.0 on failure."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json", video_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        return float(json.loads(result.stdout)["format"]["duration"])
    except Exception:
        return 0.0


# Per-segment screen time. Short cuts feel modern and keep viewer attention,
# and they keep any one source clip from being shown for more than this long
# in a single block.
SEGMENT_SECONDS = 4.5


def caption_chunks(narration_text, max_words=5):
    """
    Split narration into caption chunks that respect sentence/clause boundaries.

    Strategy: split on sentence/clause punctuation (. ! ? ; : —) first, then
    further split any clause longer than max_words into max_words-sized chunks.
    Returns a list of strings (no empty strings).
    """
    # Normalize whitespace; keep punctuation attached to the preceding word.
    text = " ".join(narration_text.split())
    # Split into clauses, keeping the trailing punctuation with its clause.
    pieces = re.split(r"(?<=[\.\!\?\;\:\—])\s+", text)

    chunks = []
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        words = piece.split()
        if len(words) <= max_words:
            chunks.append(piece)
            continue
        # Long clause — break into max_words chunks, but try to break on commas
        # if any internal commas exist so we don't slice mid-phrase.
        sub = re.split(r"(?<=,)\s+", piece)
        for s in sub:
            sw = s.split()
            if len(sw) <= max_words:
                chunks.append(s.strip())
            else:
                for i in range(0, len(sw), max_words):
                    chunks.append(" ".join(sw[i:i + max_words]))
    return [c for c in chunks if c]


def _chunk_durations(chunks, total_duration):
    """
    Weight each chunk's on-screen time by character count so longer
    chunks get more reading time. Adds a small pause after chunks that
    end in . ! or ?.
    """
    weights = []
    for c in chunks:
        w = max(len(c), 1)
        if c.rstrip().endswith((".", "!", "?")):
            w *= 1.15  # small breath
        weights.append(w)
    total_w = sum(weights) or 1.0
    return [total_duration * (w / total_w) for w in weights]


def _ass_escape(word):
    """Escape characters that have meaning in ASS dialogue text."""
    return word.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def _caption_style():
    """Read caption color/size from settings.json (with defaults)."""
    v = load_settings().get("video", {})
    return {
        "highlight_bgr": (v.get("caption_highlight_color_bgr") or "00FFFF").upper(),
        "base_size": int(v.get("caption_font_size", 72)),
        "highlight_size": int(v.get("caption_highlight_size", 90)),
    }


def plan_word_events(narration_text, audio_duration, max_words_per_chunk=5):
    """
    Build a flat list of per-word caption events for CapCut-style highlighting.

    For each chunk (line shown on screen), we emit one event per WORD covering
    the time that word is being spoken. The event's text shows the whole
    chunk, but the active word gets a bold + yellow + slightly-larger override.

    Returns a list of dicts: {start, end, text}.
    """
    chunks = caption_chunks(narration_text, max_words=max_words_per_chunk)
    if not chunks:
        return []
    chunk_durations = _chunk_durations(chunks, audio_duration)

    style = _caption_style()
    hl_color = style["highlight_bgr"]
    hl_size = style["highlight_size"]

    events = []
    chunk_start = 0.0
    for chunk, chunk_dur in zip(chunks, chunk_durations):
        words = chunk.split()
        if not words:
            chunk_start += chunk_dur
            continue

        weights = [max(len(w), 2) for w in words]
        total_w = sum(weights)
        word_durs = [chunk_dur * (w / total_w) for w in weights]

        word_cursor = chunk_start
        for i, (w, wd) in enumerate(zip(words, word_durs)):
            start = word_cursor
            end = start + wd
            parts = []
            for j, ww in enumerate(words):
                safe = _ass_escape(ww)
                if j == i:
                    parts.append(f"{{\\c&H{hl_color}&\\b1\\fs{hl_size}}}{safe}{{\\r}}")
                else:
                    parts.append(safe)
            events.append({
                "start": start,
                "end": end,
                "text": " ".join(parts),
            })
            word_cursor = end
        chunk_start += chunk_dur

    return events


def plan_word_events_from_timing(narration_text, word_timing, audio_duration, max_words_per_chunk=5):
    """Same event shape as plan_word_events, but with each per-word start/end
    taken from the TTS engine's actual timings (edge-tts WordBoundary).

    Chunks are still formed by `caption_chunks` for readable line breaks.
    We match narration words → timing entries in order; when a chunk's
    words all resolve, we anchor the chunk to real times. When the
    alignment slips (usually because the narration has punctuation/
    hyphenation the TTS engine collapses differently), we fall back to
    the previous chunk's end + a proportional split for just that chunk.
    """
    import re as _re
    chunks = caption_chunks(narration_text, max_words=max_words_per_chunk)
    if not chunks or not word_timing:
        return []
    style = _caption_style()
    hl_color = style["highlight_bgr"]
    hl_size = style["highlight_size"]

    # Normalise timing texts to bare words so we can match against
    # `narration_text.split()`. edge-tts words already lack punctuation
    # but casing/apostrophes can vary — lowercase-alnum for matching.
    def _norm(s: str) -> str:
        return _re.sub(r"[^a-z0-9]", "", s.lower())

    timing_norm = [_norm(w.get("text", "")) for w in word_timing]
    cursor = 0
    events: list[dict] = []
    chunk_prev_end = 0.0

    for chunk in chunks:
        words = chunk.split()
        # Try to find each chunk word in the remaining timing entries in order.
        chunk_word_times: list[tuple[float, float, str]] = []
        for w in words:
            target = _norm(w)
            hit = -1
            # Look ahead up to a small window to allow the TTS engine to
            # skip / merge tokens (numbers, contractions, etc.).
            for k in range(cursor, min(len(timing_norm), cursor + 5)):
                if timing_norm[k] and timing_norm[k] == target:
                    hit = k
                    break
            if hit >= 0:
                wt = word_timing[hit]
                chunk_word_times.append((wt["start_ms"] / 1000.0, wt["end_ms"] / 1000.0, w))
                cursor = hit + 1
            else:
                # Miss — mark with sentinel; we'll interpolate below.
                chunk_word_times.append((None, None, w))  # type: ignore[arg-type]
        # Anchor the chunk: use the first + last real times we found.
        anchors = [t for t in chunk_word_times if t[0] is not None]
        if not anchors:
            # Whole chunk missed — proportional-split against remaining
            # audio budget so we don't emit zero-duration events.
            fallback_dur = max(0.5, (audio_duration - chunk_prev_end) / max(1, len(chunks)))
            start = chunk_prev_end
            per = fallback_dur / max(1, len(words))
            for i, w in enumerate(words):
                s, e = start + i * per, start + (i + 1) * per
                events.append(_emit_event(s, e, words, i, hl_color, hl_size))
            chunk_prev_end = start + fallback_dur
            continue
        chunk_start = anchors[0][0]
        chunk_end   = anchors[-1][1]
        # Emit one event per word, using real start/end where we have
        # them and linear interpolation between neighbouring anchors
        # for words that missed.
        real_times: list[float | None] = []
        for (s, e, _) in chunk_word_times:
            real_times.append(s)
            real_times.append(e)
        # Fill None gaps by linear interpolation between neighbouring
        # non-None entries.
        real_times = _interp_none(real_times, chunk_start, chunk_end)
        for i, w in enumerate(words):
            s = real_times[i * 2]
            e = real_times[i * 2 + 1]
            if s is None or e is None or e <= s:
                continue
            events.append(_emit_event(s, e, words, i, hl_color, hl_size))
        chunk_prev_end = chunk_end
    return events


def _emit_event(start: float, end: float, words: list[str], active_idx: int, hl_color: str, hl_size: int) -> dict:
    parts = []
    for j, ww in enumerate(words):
        safe = _ass_escape(ww)
        if j == active_idx:
            parts.append(f"{{\\c&H{hl_color}&\\b1\\fs{hl_size}}}{safe}{{\\r}}")
        else:
            parts.append(safe)
    return {"start": start, "end": end, "text": " ".join(parts)}


def _interp_none(vals: list[float | None], lo: float, hi: float) -> list[float]:
    """Linear-interpolate None entries between anchor floats. Endpoints
    default to lo/hi if the sequence begins/ends with None."""
    n = len(vals)
    if n == 0:
        return []
    out: list[float] = [0.0] * n
    # Prefix anchors
    prev_idx = -1
    prev_val: float = lo
    for i in range(n):
        if vals[i] is not None:
            v = float(vals[i])  # type: ignore[arg-type]
            # Fill Nones between prev_idx and i.
            for k in range(prev_idx + 1, i):
                if prev_idx == -1:
                    out[k] = lo + (v - lo) * (k + 1) / (i + 1)
                else:
                    out[k] = prev_val + (v - prev_val) * (k - prev_idx) / (i - prev_idx)
            out[i] = v
            prev_idx = i
            prev_val = v
    # Trailing Nones after the last anchor
    if prev_idx < n - 1:
        for k in range(prev_idx + 1, n):
            out[k] = prev_val + (hi - prev_val) * (k - prev_idx) / (n - prev_idx)
    return out


def _load_word_timing_sidecar(audio_path: str) -> list[dict] | None:
    """Return per-word timing from the edge-tts .words.json sidecar if it
    exists next to the audio. Returns None on any error so the caller
    falls back to the character-count heuristic."""
    import json as _json
    import os as _os
    sidecar = audio_path + ".words.json" if audio_path else None
    if not sidecar or not _os.path.exists(sidecar):
        return None
    try:
        with open(sidecar, encoding="utf-8") as f:
            data = _json.load(f)
        words = data.get("words") or []
        # Sanity: need at least a handful of boundaries; empty sidecars
        # aren't better than the heuristic.
        if isinstance(words, list) and len(words) >= 4:
            return words
    except Exception:
        pass
    return None


def create_caption_file(narration_text, audio_duration, output_path, audio_path: str | None = None):
    """
    Generate an ASS subtitle file with CapCut-style word-by-word highlighting:
    the whole sentence is visible, and the currently-spoken word is bolded,
    enlarged, and tinted yellow as the narration progresses.

    When `audio_path` is provided AND its .words.json sidecar exists
    (edge-tts writes it during synthesis), we use the ACTUAL per-word
    start/end timing captured from the TTS engine — millisecond-accurate,
    no drift. Falls back to the character-count heuristic when the
    sidecar is absent (Kokoro path, older cached audio, etc.).
    """
    word_timing = _load_word_timing_sidecar(audio_path) if audio_path else None
    if word_timing:
        events = plan_word_events_from_timing(narration_text, word_timing, audio_duration)
        log.info(f"captions: using {len(word_timing)} TTS-emitted word timings (drift-free)")
    else:
        events = plan_word_events(narration_text, audio_duration)
        log.info("captions: using character-count heuristic (no TTS word-timing sidecar)")
    if not events:
        # Degenerate input — still emit a single placeholder so ffmpeg's
        # ass filter doesn't choke on an empty events block.
        events = [{"start": 0.0, "end": max(audio_duration, 0.1), "text": "..."}]

    def fmt_time(seconds):
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = seconds % 60
        return f"{h}:{m:02d}:{s:05.2f}"

    base_size = _caption_style()["base_size"]
    ass_header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Arial,{base_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,220,1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = []
    for e in events:
        lines.append(
            f"Dialogue: 0,{fmt_time(e['start'])},{fmt_time(e['end'])},"
            f"Default,,0,0,0,,{e['text']}"
        )

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(ass_header + "\n".join(lines))

    return output_path


MIN_SEGMENT = 2.0   # never show a single source for less than this
MAX_SEGMENT = 7.0   # never show a single source for more than this


def _plan_segments(sources, target_duration):
    """
    Plan a montage where each source appears EXACTLY ONCE. Returns a list of
    (source_dict, start_offset, segment_duration). For images start_offset
    is always 0 (irrelevant for stills).

    Per-segment duration is target_duration / N, then clamped to
    [MIN_SEGMENT, MAX_SEGMENT]. For video sources we further clamp to the
    clip's available material at the chosen offset.
    """
    if not sources:
        return []

    # Probe video durations once.
    enriched = []
    for src in sources:
        if src["type"] == "video":
            d = get_video_duration(src["path"])
            if d < 0.8:
                log.warning(f"source {src['path']} unusable duration {d:.2f}s — skipping")
                continue
            enriched.append((src, d))
        else:
            # Images can play any length we choose.
            enriched.append((src, float("inf")))

    if not enriched:
        return []

    # If every source carries pre-assigned start/end from the storyboard,
    # use those exact timings — that's what guarantees image-on-screen
    # matches words-being-spoken. Otherwise we redistribute uniformly.
    has_shot_timing = all(
        isinstance(s, dict)
        and "start" in s and "end" in s
        and float(s.get("end", 0.0)) > float(s.get("start", 0.0))
        for s, _ in enriched
    )

    # Per-segment bounds come from settings so the GUI can tune pacing.
    vid_cfg = load_settings().get("video", {})
    mn = float(vid_cfg.get("min_segment_seconds", MIN_SEGMENT))
    mx = float(vid_cfg.get("max_segment_seconds", MAX_SEGMENT))

    segments = []

    if has_shot_timing:
        # Shot-driven: durations come straight from the storyboard.
        for src, src_dur in enriched:
            seg = max(0.5, float(src["end"]) - float(src["start"]))
            if src["type"] == "video":
                # Choose a clip-internal start so we have `seg` seconds available.
                max_start = max(0.0, src_dur - seg - 0.1)
                clip_start = random.uniform(0.0, max_start) if max_start > 0.5 else 0.0
                seg = min(seg, max(0.5, src_dur - clip_start))
            else:
                clip_start = 0.0
            segments.append((src, clip_start, seg))
        return segments

    # Uniform redistribution (used when no storyboard timing is available).
    n = len(enriched)
    remaining = target_duration
    for i, (src, dur) in enumerate(enriched):
        sources_left = n - i
        seg = remaining / sources_left
        seg = max(mn, min(mx, seg))
        if i == n - 1:
            seg = max(seg, min(remaining, mx * 1.5))

        if src["type"] == "video":
            max_start = max(0.0, dur - seg - 0.1)
            start = random.uniform(0.0, max_start) if max_start > 0.5 else 0.0
            seg = min(seg, max(mn, dur - start))
        else:
            start = 0.0

        segments.append((src, start, seg))
        remaining = max(0.0, remaining - seg)

    return segments


def _render_video_segment(src, start, dur, out_path):
    """Cut a video segment, scale + crop to portrait, no audio.

    Dispatches to the GPU renderer (modules.editor_gpu) when available
    AND settings.video.render_pipeline allows it. Per-segment fallback:
    on any non-Cancelled exception from the GPU path we log and fall
    through to the ffmpeg path for this one segment.
    """
    if _use_gpu_renderer():
        try:
            return editor_gpu.render_video_segment_gpu(
                src["path"], start, dur, out_path,
                fps=OUTPUT_FPS, w=OUTPUT_WIDTH, h=OUTPUT_HEIGHT, crf=23,
            )
        except Exception as e:
            from modules import run_state as _rs
            if isinstance(e, _rs.Cancelled):
                raise
            log.warning(
                f"editor_gpu: render_video_segment failed for "
                f"{os.path.basename(src['path'])} ({e.__class__.__name__}: {e}); "
                f"falling back to ffmpeg for this segment"
            )
            _mark_gpu_broken(f"{e.__class__.__name__}: {str(e)[:80]}")
    return _render_video_segment_ffmpeg(src, start, dur, out_path)


def _render_video_segment_ffmpeg(src, start, dur, out_path):
    """ffmpeg-only path. NVENC encode but CPU decode/scale/crop.

    This is the historical implementation, kept verbatim so HF Space and
    any other torch-less worker continues to work unchanged. Also acts as
    the per-segment fallback when the GPU path errors on a specific clip.
    """
    run_ffmpeg([
        "-ss", f"{start:.2f}",
        "-i", src["path"],
        "-t", f"{dur:.2f}",
        "-vf", (
            f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,"
            f"crop={OUTPUT_WIDTH}:{OUTPUT_HEIGHT},"
            f"fps={OUTPUT_FPS}"
        ),
        "-an",
        *_vcodec_args(crf="23"),
        "-pix_fmt", "yuv420p",
        out_path,
    ], desc=f"video segment from {os.path.basename(src['path'])} +{start:.1f}s {dur:.1f}s")


def _ken_burns_filter(motion, frames):
    """
    Generate the zoompan portion of the filter chain for the given motion
    style. Returns a partial filtergraph segment that takes a 2×-scaled
    input and produces the final OUTPUT_WIDTH×OUTPUT_HEIGHT frame.

    motion ∈ {"zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"}
    """
    W, H, FPS = OUTPUT_WIDTH, OUTPUT_HEIGHT, OUTPUT_FPS
    # max zoom for pure-zoom moves; mid-zoom for pans so we have headroom to pan.
    if motion == "zoom_in":
        return (f"zoompan=z='min(zoom+0.0015,1.15)':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                f"s={W}x{H}:fps={FPS}")
    if motion == "zoom_out":
        return (f"zoompan=z='if(eq(on,0),1.15,max(zoom-0.0015,1.0))':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                f"s={W}x{H}:fps={FPS}")
    if motion == "pan_left":
        return (f"zoompan=z='1.10':d={frames}:"
                f"x='(iw-iw/zoom)*on/{max(frames-1,1)}':y='ih/2-(ih/zoom/2)':"
                f"s={W}x{H}:fps={FPS}")
    if motion == "pan_right":
        return (f"zoompan=z='1.10':d={frames}:"
                f"x='(iw-iw/zoom)*(1-on/{max(frames-1,1)})':y='ih/2-(ih/zoom/2)':"
                f"s={W}x{H}:fps={FPS}")
    if motion == "pan_up":
        return (f"zoompan=z='1.10':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/{max(frames-1,1)}':"
                f"s={W}x{H}:fps={FPS}")
    if motion == "pan_down":
        return (f"zoompan=z='1.10':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/{max(frames-1,1)})':"
                f"s={W}x{H}:fps={FPS}")
    # Fallback = centered slow zoom
    return (f"zoompan=z='min(zoom+0.0015,1.12)':d={frames}:"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"s={W}x{H}:fps={FPS}")


def _grade_chain(channel, intensity):
    """
    Color grade + vignette + film grain — applied AFTER zoompan so the
    geometry's settled. `intensity` ∈ [0, 1] scales the effects' strength.
    Returns a comma-joined filter chunk (or empty if intensity ≤ 0).
    """
    if intensity <= 0:
        return ""
    parts = []
    # Color grade
    if channel == "horror":
        # Cooler shadows, crushed blacks, slight desaturation.
        contrast    = 1.0 + 0.18 * intensity
        saturation  = 1.0 - 0.20 * intensity
        gamma       = 1.0 - 0.05 * intensity
        parts.append(f"eq=contrast={contrast:.3f}:saturation={saturation:.3f}:gamma={gamma:.3f}")
        parts.append(f"colorbalance=bs={0.08*intensity:.3f}:bm={0.04*intensity:.3f}:rs={-0.05*intensity:.3f}")
    else:
        # Wisdom / default: warmer, slightly punchier.
        contrast    = 1.0 + 0.10 * intensity
        saturation  = 1.0 + 0.12 * intensity
        parts.append(f"eq=contrast={contrast:.3f}:saturation={saturation:.3f}")
        parts.append(f"colorbalance=rs={0.06*intensity:.3f}:rm={0.04*intensity:.3f}:bs={-0.04*intensity:.3f}")
    # Vignette — corners gently darkened.
    parts.append(f"vignette=angle=PI/{5.0 - 1.5*intensity:.2f}")
    # Film grain — subtle temporal noise, capped so it never looks like static.
    grain = int(round(6 + 10 * intensity))   # ~6 at low, ~16 at full
    parts.append(f"noise=alls={grain}:allf=t")
    return ",".join(parts)


# Motion cycle: deterministic round-robin so consecutive image segments
# don't both do the same move. Module-level so it persists across calls
# within a single run.
_MOTIONS = ["zoom_in", "pan_right", "zoom_out", "pan_left", "pan_up", "pan_down"]


def _pick_motion(index):
    return _MOTIONS[index % len(_MOTIONS)]


# Counter incremented by _render_image_segment to drive _pick_motion.
_image_segment_index = 0


def _render_image_segment(src, dur, out_path, channel="horror"):
    """
    Render a still image as a dur-seconds clip with a cinematic motion
    style (zoom in/out, pan in 4 directions) plus color grading, vignette,
    and film grain controlled by settings.video.effects_intensity.

    Dispatches to the GPU renderer (modules.editor_gpu) when available.
    Same per-segment fallback discipline as _render_video_segment.
    """
    global _image_segment_index
    motion = _pick_motion(_image_segment_index)
    _image_segment_index += 1

    intensity = float(load_settings().get("video", {}).get("effects_intensity", 0.7))
    intensity = max(0.0, min(1.0, intensity))

    if _use_gpu_renderer():
        try:
            return editor_gpu.render_image_segment_gpu(
                src["path"], dur, out_path,
                motion=motion, channel=channel, intensity=intensity,
                fps=OUTPUT_FPS, w=OUTPUT_WIDTH, h=OUTPUT_HEIGHT, crf=22,
            )
        except Exception as e:
            from modules import run_state as _rs
            if isinstance(e, _rs.Cancelled):
                raise
            log.warning(
                f"editor_gpu: render_image_segment failed for "
                f"{os.path.basename(src['path'])} ({e.__class__.__name__}: {e}); "
                f"falling back to ffmpeg for this segment"
            )
            _mark_gpu_broken(f"{e.__class__.__name__}: {str(e)[:80]}")

    return _render_image_segment_ffmpeg(src, dur, out_path, channel=channel,
                                        motion=motion, intensity=intensity)


def _render_image_segment_ffmpeg(src, dur, out_path, *, channel, motion, intensity):
    """ffmpeg-only Ken Burns + grade. Historical path, kept verbatim."""
    frames = max(1, int(round(dur * OUTPUT_FPS)))
    W, H = OUTPUT_WIDTH, OUTPUT_HEIGHT

    # Pre-scale 2× so zoompan + pan has headroom inside the source.
    pre = (
        f"scale={W*2}:{H*2}:force_original_aspect_ratio=increase,"
        f"crop={W*2}:{H*2}"
    )
    ken = _ken_burns_filter(motion, frames)
    grade = _grade_chain(channel, intensity)
    vf = ",".join([p for p in (pre, ken, grade) if p])

    run_ffmpeg([
        "-loop", "1",
        "-i", src["path"],
        "-t", f"{dur:.2f}",
        "-vf", vf,
        "-an",
        *_vcodec_args(crf="22"),
        "-pix_fmt", "yuv420p",
        out_path,
    ], desc=f"image segment ({motion}, fx={intensity:.1f}) from {os.path.basename(src['path'])} {dur:.1f}s")


def prepare_clips(sources, target_duration, work_dir, channel="horror"):
    """
    Build a no-repeat montage: every source in `sources` is shown exactly
    ONCE. `sources` is a list of {type: "video"|"image", path: ...} dicts.

    `channel` drives the image-segment color grade (horror = cold/desaturated,
    wisdom = warm/punchy).

    Returns path to a concatenated raw video file (no audio).
    """
    global _image_segment_index
    _image_segment_index = 0  # reset motion cycle per run

    segments = _plan_segments(sources, target_duration)
    if not segments:
        raise RuntimeError("prepare_clips: no usable sources")

    vid_count = sum(1 for s, _, _ in segments if s["type"] == "video")
    img_count = sum(1 for s, _, _ in segments if s["type"] == "image")
    log.info(f"Montage plan: {len(segments)} segments (no repeats) — "
             f"{vid_count} videos + {img_count} images, target ~{target_duration:.1f}s")

    # Edit owns 60%..92% of the bar (32% wide). Per-segment encoding is
    # ~70% of that work and the rest is concat + final mux. So scale the
    # per-segment tick from 0.0 to 0.7.
    from modules import run_state
    segment_files = []
    n = max(1, len(segments))
    for i, (src, start, dur) in enumerate(segments):
        run_state.check_cancel()
        out = os.path.join(work_dir, f"seg_{i:02d}.mp4")
        if src["type"] == "video":
            _render_video_segment(src, start, dur, out)
        else:
            _render_image_segment(src, dur, out, channel=channel)
        segment_files.append(out)
        run_state.tick("edit", 0.7 * (i + 1) / n)

    concat_list = os.path.join(work_dir, "concat.txt")
    with open(concat_list, "w") as f:
        for c in segment_files:
            abs_path = os.path.abspath(c).replace("\\", "/")
            f.write(f"file '{abs_path}'\n")

    concat_out = os.path.join(work_dir, "background_raw.mp4")
    # Re-encode on concat (not -c copy) because image segments may have
    # slightly different encode params than video segments, and -c copy
    # would refuse to splice them. CRF 23 keeps quality at a sane level.
    run_ffmpeg([
        "-f", "concat", "-safe", "0",
        "-i", os.path.abspath(concat_list),
        "-t", str(target_duration),
        *_vcodec_args(crf="23"),
        "-pix_fmt", "yuv420p",
        concat_out,
    ], desc="concat segments")
    return concat_out


def assemble_video(voiceover_path, sources, music_path, narration_text, output_dir,
                    channel="horror"):
    """
    Full assembly pipeline. Returns path to final MP4.

    `sources` is a list of {type, path} dicts as produced by footage.get_footage.
    Each source is shown exactly once — no clip is ever repeated.
    `channel` drives the image color grade.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    work_dir = os.path.join(output_dir, "_work")
    Path(work_dir).mkdir(exist_ok=True)

    log.info("Getting audio duration...")
    duration = get_audio_duration(voiceover_path)
    log.info(f"Voiceover duration: {duration:.1f}s")

    # Step 1: Prepare background video (one segment per source, no repeats)
    log.info("Preparing background montage...")
    bg_video = prepare_clips(sources, duration, work_dir, channel=channel)

    # Step 2: Create caption file
    caption_filename = "captions.ass"
    caption_path = os.path.join(work_dir, caption_filename)
    create_caption_file(narration_text, duration, caption_path, audio_path=voiceover_path)

    final_path = os.path.join(output_dir, "final_video.mp4")

    # Resolve everything else to absolute paths BEFORE we change the ffmpeg
    # subprocess's working directory below. These are plain -i/output
    # arguments (not parsed by the filtergraph), so absolute Windows paths
    # with drive letters are totally fine here — the colon problem only
    # ever bites inside a filter option string like `ass=<path>`.
    work_dir_abs = os.path.abspath(work_dir)
    bg_video_abs = os.path.abspath(bg_video)
    voiceover_path_abs = os.path.abspath(voiceover_path)
    final_path_abs = os.path.abspath(final_path)
    music_path_abs = os.path.abspath(music_path) if music_path else None

    # Output encoder settings — tune for size vs. quality via GUI.
    _vcfg = load_settings().get("video", {})
    out_crf    = str(int(_vcfg.get("output_crf", 23)))
    out_preset = str(_vcfg.get("output_preset", "medium"))
    out_abr    = str(_vcfg.get("output_audio_bitrate", "96k"))
    log.info(f"Output encode: crf={out_crf} preset={out_preset} audio={out_abr}")

    def _final_assembly_no_music():
        """Voiceover only — used when music is unavailable or the music
        sidechain branch fails."""
        run_ffmpeg([
            "-i", bg_video_abs,
            "-i", voiceover_path_abs,
            "-filter_complex",
            f"[0:v]ass={caption_filename}[vout]",
            "-map", "[vout]", "-map", "1:a",
            *_vcodec_args(crf=out_crf, preset_cpu=out_preset),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", out_abr,
            "-t", str(duration),
            "-movflags", "+faststart",
            final_path_abs,
        ], desc="final assembly (no music)", cwd=work_dir_abs)

    # Run ffmpeg with cwd=work_dir_abs and reference the caption file by its
    # bare filename. No drive letter, no colon, nothing for the ass filter's
    # parser to misinterpret as "original_size".
    if music_path and os.path.exists(music_path):
        vcfg = load_settings().get("video", {})
        mvol  = float(vcfg.get("music_base_volume", 0.55))
        mthr  = float(vcfg.get("music_duck_threshold", 0.15))
        mrat  = float(vcfg.get("music_duck_ratio", 4.0))
        try:
            run_ffmpeg([
                "-i", bg_video_abs,
                "-i", voiceover_path_abs,
                "-i", music_path_abs,
                "-filter_complex",
                (
                    f"[1:a]asplit=2[v1][vsc];"
                    f"[2:a]volume={mvol}[m_raw];"
                    f"[m_raw][vsc]sidechaincompress=threshold={mthr}:ratio={mrat}:attack=20:release=300[m_ducked];"
                    f"[v1][m_ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout];"
                    f"[0:v]ass={caption_filename}[vout]"
                ),
                "-map", "[vout]", "-map", "[aout]",
                *_vcodec_args(crf=out_crf, preset_cpu=out_preset),
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", out_abr,
                "-t", str(duration),
                "-movflags", "+faststart",
                final_path_abs,
            ], desc="final assembly with ducked music", cwd=work_dir_abs)
        except Exception as e:
            # IMPORTANT: don't catch Cancelled here. It's a RuntimeError
            # subclass, so the previous `except RuntimeError` swallowed
            # user-initiated cancels and triggered the no-music fallback —
            # making the dashboard look stuck because a NEW ffmpeg
            # immediately started. Re-raise cancellation explicitly so
            # the pipeline unwinds.
            from modules import run_state as _rs
            if isinstance(e, _rs.Cancelled):
                raise
            # Some ffmpeg builds (e.g. CapCut's bundled binary) silently
            # break on the sidechaincompress filter graph. Rather than
            # losing the whole video over background music, fall back to
            # a voice-only mix so the user still gets their content.
            log.warning(
                f"Music-mix step failed ({e}); retrying without background music. "
                f"The final video will have voiceover only."
            )
            _final_assembly_no_music()
    else:
        _final_assembly_no_music()

    log.info(f"Final video: {final_path}")
    return final_path
