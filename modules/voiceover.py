"""
voiceover.py — Text-to-Speech Module
Primary:  edge-tts  (Microsoft neural voices, free, no API key)
Fallback: kokoro    (local model, best quality, requires pip install kokoro)

Voice selection is per-channel: the niche preset in modules/channels.py
carries `voice`, `voices` (alternates), `rate`, `pitch`, and optionally
`voices_by_lang` for multilingual niches. settings.json overrides the
preset when the user wants to tweak a niche globally without editing code.

Language switching: pass language="ur" / "hi" / "es" / etc. The function
picks the matching voice from voices_by_lang[lang], falls back to
LANG_DEFAULT_VOICES[lang] if the niche doesn't have a per-language voice,
and finally to the niche's default English voice.
"""
import os
import asyncio
import logging
import traceback
from pathlib import Path
from dotenv import load_dotenv

from modules._net import retry
from modules.config import load_settings

load_dotenv()
log = logging.getLogger(__name__)


# Sensible defaults per language for niches that don't ship their own
# per-language voice. Adding a language to the system = one entry here.
# (All are edge-tts voice ids; kokoro doesn't yet support these languages
# so kokoro automatically yields to edge-tts when language != "en".)
LANG_DEFAULT_VOICES: dict[str, dict[str, str]] = {
    "en": {"male": "en-US-BrianMultilingualNeural",  "female": "en-US-AriaNeural"},
    "ur": {"male": "ur-PK-AsadNeural",               "female": "ur-PK-UzmaNeural"},
    "hi": {"male": "hi-IN-MadhurNeural",             "female": "hi-IN-SwaraNeural"},
    "es": {"male": "es-ES-AlvaroNeural",             "female": "es-ES-ElviraNeural"},
    "fr": {"male": "fr-FR-HenriNeural",              "female": "fr-FR-DeniseNeural"},
    "de": {"male": "de-DE-ConradNeural",             "female": "de-DE-KatjaNeural"},
    "ar": {"male": "ar-SA-HamedNeural",              "female": "ar-SA-ZariyahNeural"},
    "pt": {"male": "pt-BR-AntonioNeural",            "female": "pt-BR-FranciscaNeural"},
    "it": {"male": "it-IT-DiegoNeural",              "female": "it-IT-ElsaNeural"},
    "ja": {"male": "ja-JP-KeitaNeural",              "female": "ja-JP-NanamiNeural"},
    "ko": {"male": "ko-KR-InJoonNeural",             "female": "ko-KR-SunHiNeural"},
    "zh": {"male": "zh-CN-YunxiNeural",              "female": "zh-CN-XiaoxiaoNeural"},
    "pl": {"male": "pl-PL-MarekNeural",              "female": "pl-PL-ZofiaNeural"},
    "nl": {"male": "nl-NL-MaartenNeural",            "female": "nl-NL-ColetteNeural"},
    "tr": {"male": "tr-TR-AhmetNeural",              "female": "tr-TR-EmelNeural"},
    "id": {"male": "id-ID-ArdiNeural",               "female": "id-ID-GadisNeural"},
    "ru": {"male": "ru-RU-DmitryNeural",             "female": "ru-RU-SvetlanaNeural"},
    "vi": {"male": "vi-VN-NamMinhNeural",            "female": "vi-VN-HoaiMyNeural"},
    "th": {"male": "th-TH-NiwatNeural",              "female": "th-TH-PremwadeeNeural"},
    "bn": {"male": "bn-IN-BashkarNeural",            "female": "bn-IN-TanishaaNeural"},
}

# Niche → preferred gender for the language default lookup. Picked to
# match the niche tone (horror leans male/baritone, wisdom male/measured,
# comedy female/varied, etc.). Falls back to "male".
NICHE_GENDER_HINT = {
    "horror":   "male",
    "wisdom":   "male",
    "finance":  "male",
    "fitness":  "male",
    "science":  "female",
    "history":  "male",
    "comedy":   "female",
    "food":     "female",
    "travel":   "female",
    "gaming":   "male",
}


def _resolve_voice(preset: dict, language: str | None, voice_override: str | None = None) -> tuple[str, str, str]:
    """Resolve (voice_id, rate, pitch) from the channel preset honoring
    the requested language. settings.json can override either the per-
    niche voice OR the per-language voice — useful when a user wants a
    specific voice for ALL their Urdu content regardless of niche.

    `voice_override` — user's per-render pick from the /create wizard.
    Wins over every other source unless it's obviously wrong for the
    selected language (BCP-47 prefix mismatch), in which case we log
    and fall through so we don't get "German script, English voice".
    """
    settings = load_settings().get("voice", {})
    niche = preset.get("name") or "horror"
    lang = (language or preset.get("language") or "en").lower()[:2]

    # 0. Per-render voice override from the wizard. Sanity check that the
    # picked voice's locale prefix matches the requested language — if a
    # user picked en-US-Aria for a German render (either UI bug or stale
    # pick from a previous session), fall through to language defaults
    # so audio doesn't ship in the wrong language.
    if voice_override:
        ov = voice_override.strip()
        ov_lang = ov.split("-", 1)[0].lower()[:2] if "-" in ov else ""
        if not ov_lang or ov_lang == lang:
            return ov, settings.get(f"edge_rate_{niche}", preset.get("rate", "+0%")), \
                   settings.get(f"edge_pitch_{niche}", preset.get("pitch", "+0Hz"))
        else:
            log.warning(
                f"voice_override {ov!r} language={ov_lang} doesn't match "
                f"pipeline language={lang}; falling back to language defaults"
            )

    # 1. settings.json override for THIS niche + language pair.
    override = settings.get(f"edge_voice_{niche}_{lang}")
    if override:
        return override, settings.get(f"edge_rate_{niche}", preset.get("rate", "+0%")), \
               settings.get(f"edge_pitch_{niche}", preset.get("pitch", "+0Hz"))

    # 2. Niche preset has a per-language map.
    voices_by_lang = preset.get("voices_by_lang") or {}
    if lang in voices_by_lang and voices_by_lang[lang]:
        candidates = voices_by_lang[lang]
        # Accept either a list (use first) or a string.
        voice_id = candidates[0] if isinstance(candidates, list) else candidates
        return voice_id, preset.get("rate", "+0%"), preset.get("pitch", "+0Hz")

    # 3. Cross-language voice from LANG_DEFAULT_VOICES.
    if lang != "en" and lang in LANG_DEFAULT_VOICES:
        gender = NICHE_GENDER_HINT.get(niche, "male")
        voice_id = LANG_DEFAULT_VOICES[lang].get(gender) \
                   or LANG_DEFAULT_VOICES[lang].get("male")
        if voice_id:
            return voice_id, preset.get("rate", "+0%"), preset.get("pitch", "+0Hz")

    # 4. Niche's default English voice (existing behavior).
    settings_voice = settings.get(f"edge_voice_{niche}")
    voice = settings_voice or preset.get("voice", "en-US-BrianMultilingualNeural")
    rate = settings.get(f"edge_rate_{niche}", preset.get("rate", "+0%"))
    pitch = settings.get(f"edge_pitch_{niche}", preset.get("pitch", "+0Hz"))
    return voice, rate, pitch


def _voice_config(channel_type, language=None, voice_override=None):
    """Build the per-channel voice config dict. Reads the niche preset
    (which is the source of truth) and merges any settings.json overrides
    + language selection + wizard-picked voice_override."""
    from modules.channels import get_channel
    preset = get_channel(channel_type)
    voice, rate, pitch = _resolve_voice(preset, language, voice_override=voice_override)
    s = load_settings().get("voice", {})
    # Kokoro voice priority (per 2026-07-13 audit #10 — was hardcoded
    # "am_michael" fallback which ignored the niche preset entirely):
    #   1. Global settings.voice.kokoro_voice_<niche>  — operator's
    #      per-niche override in /settings.
    #   2. Niche preset's kokoro_voice (from modules/channels.py).
    #   3. Hardcoded "am_michael" as last resort.
    _kokoro_voice = (
        s.get(f"kokoro_voice_{channel_type}")
        or preset.get("kokoro_voice")
        or "am_michael"
    )
    _kokoro_speed = float(
        s.get(f"kokoro_speed_{channel_type}",
              preset.get("kokoro_speed", 0.9))
    )
    return {
        "edge":         voice,
        "edge_rate":    rate,
        "edge_pitch":   pitch,
        "kokoro":       _kokoro_voice,
        "kokoro_speed": _kokoro_speed,
        "language":     (language or preset.get("language") or "en").lower()[:2],
    }


# Edge-tts hits a Microsoft WebSocket. When the connection wedges (proxy,
# flaky network, server hiccup) `communicate.save()` will hang forever with
# no exception. A hard asyncio timeout forces it to raise so retry() can
# catch and move on instead of stalling the entire pipeline.
EDGE_TTS_TIMEOUT = 90  # seconds per attempt — generous; normal runs take 5-15s


async def _edge_tts_async(text, voice, output_path, rate="+0%", pitch="+0Hz"):
    """Generate audio using edge-tts (async). Supports rate/pitch prosody."""
    import edge_tts
    # Capture the audio AND the WordBoundary events edge-tts emits
    # during synthesis. WordBoundary carries millisecond-accurate
    # per-word start/duration; we persist them next to the .mp3 as a
    # .words.json sidecar so the editor can build word-locked
    # subtitles instead of estimating timing from character counts
    # (which drifted noticeably on longer narrations — every user
    # complaint of 'subtitles not syncing' traces here).
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    boundaries: list[dict] = []

    async def _drive():
        with open(output_path, "wb") as f:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    # offset + duration are in 100-nanosecond units.
                    boundaries.append({
                        "start_ms": int(chunk["offset"]) / 10_000,
                        "end_ms":   (int(chunk["offset"]) + int(chunk["duration"])) / 10_000,
                        "text":     str(chunk["text"]),
                    })

    await asyncio.wait_for(_drive(), timeout=EDGE_TTS_TIMEOUT)

    if boundaries:
        sidecar = output_path + ".words.json"
        try:
            import json as _json
            with open(sidecar, "w", encoding="utf-8") as f:
                _json.dump({"words": boundaries, "count": len(boundaries)}, f)
            log.info(f"edge-tts: captured {len(boundaries)} word timings → {sidecar}")
        except Exception as e:
            log.warning(f"edge-tts: failed to write word-timing sidecar: {e}")


def generate_with_edge_tts(text, channel_type, output_path, language=None, voice_override=None):
    """
    Generate voiceover using Microsoft edge-tts (free, no key needed).
    Returns path to .mp3 file.
    """
    cfg = _voice_config(channel_type, language=language, voice_override=voice_override)
    voice = cfg["edge"]
    rate = cfg.get("edge_rate", "+0%")
    pitch = cfg.get("edge_pitch", "+0Hz")
    log.info(
        f"Generating TTS with edge-tts | voice={voice} rate={rate} "
        f"pitch={pitch} lang={cfg['language']} (timeout={EDGE_TTS_TIMEOUT}s/attempt)"
    )
    try:
        retry(
            lambda: asyncio.run(_edge_tts_async(text, voice, output_path, rate=rate, pitch=pitch)),
            attempts=3,
            on=(asyncio.TimeoutError, ConnectionError, OSError, Exception),
            desc="edge-tts",
        )
    except Exception as e:
        log.error(f"edge-tts failed after retries: {e}")
        return None
    # Validate the produced file actually has content.
    if not os.path.exists(output_path) or os.path.getsize(output_path) < 1024:
        log.error(f"edge-tts produced empty/missing file: {output_path}")
        return None
    log.info(f"Audio saved: {output_path}")
    return output_path


# Once kokoro fails to import (broken torch install, missing model, etc.)
# the failure is permanent for the process lifetime — every subsequent
# generate_voiceover call would hit the same error. Track that here so
# we silently skip kokoro after the first failure instead of logging
# a scary ERROR before falling back to edge-tts on every single video.
_KOKORO_BROKEN = False
_KOKORO_BROKEN_REASON: str | None = None

# Cap kokoro generation. On a low-power CPU (i5-8265U class) a ~170-word
# narration legitimately takes 60-120s; anything past 4 min is a hang or
# something genuinely wrong, and falling back to edge-tts is better.
KOKORO_WALL_CLOCK_BUDGET_SECONDS = 240


def kokoro_broken_reason() -> str | None:
    """Exposed for the /health page so the dashboard can show WHY
    kokoro is disabled this run (was a silent black-hole before)."""
    return _KOKORO_BROKEN_REASON


def _gpu_supported_by_modern_torch() -> bool:
    """Return False if the CUDA device has compute-capability < 7.0
    (Pascal / Kepler / Maxwell). Modern PyTorch wheels dropped sm_5x
    and sm_6x kernels, so a `.to("cuda")` on such devices raises
    'no kernel image is available for execution on the device' at the
    first tensor op. Kaggle's free P100 is sm_6.0 and hits this every
    single job. Detect + skip early instead of showing a five-frame
    traceback on every render."""
    try:
        import torch
        if not torch.cuda.is_available():
            return False
        # Kokoro pins to gpu_topology.kokoro_device (cuda:1 on T4x2,
        # cuda:0 otherwise). Probe that specific device so a
        # single-sm_6 sibling doesn't disable Kokoro on the sm_7+ card.
        try:
            from modules import gpu_topology as _gt
            dev = _gt.kokoro_device if _gt.kokoro_device is not None else 0
        except Exception:
            dev = 0
        cap = torch.cuda.get_device_capability(dev)
        return cap[0] >= 7
    except Exception:
        return False


def _write_kokoro_word_timing_sidecar(narration_text: str, chunk_records: list[dict],
                                       output_path: str) -> None:
    """Convert Kokoro's per-chunk (graphemes, duration_s) records into a
    per-word timing sidecar in the same shape edge-tts writes.

    Sidecar format (matches modules.editor._load_word_timing_sidecar):
        {
          "words": [{"start_ms": float, "end_ms": float, "text": str}, ...],
          "count": int
        }

    Approach:
      - Each Kokoro chunk covers a slice of the original narration and
        has a KNOWN audio duration (samples / sample_rate). Split the
        chunk's grapheme text into whitespace-delimited words, then
        distribute the chunk duration across those words by character
        weight (max(len(w), 2) — same weighting the character heuristic
        uses inside a chunk).
      - Chunk BOUNDARIES are anchored to real audio playback offsets —
        that's where the big drift used to accumulate under the pure
        character-count heuristic.

    Any exception here just means the sidecar isn't written — the
    editor falls back to plan_word_events (character heuristic) with
    no regression versus the old behavior.
    """
    import json as _json
    if not chunk_records:
        return
    words_out: list[dict] = []
    cursor_s = 0.0
    for rec in chunk_records:
        graphemes = str(rec.get("graphemes") or "").strip()
        chunk_dur = float(rec.get("duration_s") or 0.0)
        if chunk_dur <= 0:
            continue
        # Words spoken in this chunk. If graphemes is empty (older
        # Kokoro release), fall back to leaving the chunk as a single
        # "block" event so at least chunk-level anchoring holds.
        chunk_words = graphemes.split() if graphemes else []
        if not chunk_words:
            cursor_s += chunk_dur
            continue
        weights = [max(len(w), 2) for w in chunk_words]
        total_w = float(sum(weights)) or 1.0
        word_start = cursor_s
        for w, wt in zip(chunk_words, weights):
            wd = chunk_dur * (float(wt) / total_w)
            words_out.append({
                "start_ms": round(word_start * 1000.0, 3),
                "end_ms":   round((word_start + wd) * 1000.0, 3),
                "text":     w,
            })
            word_start += wd
        cursor_s += chunk_dur

    if not words_out:
        return
    sidecar = output_path + ".words.json"
    with open(sidecar, "w", encoding="utf-8") as f:
        _json.dump({"words": words_out, "count": len(words_out), "source": "kokoro"}, f)
    log.info(f"kokoro: captured {len(words_out)} chunk-anchored word timings → {sidecar}")


def generate_with_kokoro(text, channel_type, output_path, language=None):
    """
    Generate voiceover using Kokoro-82M (local, higher quality).
    Requires: pip install kokoro soundfile

    Kokoro currently ships English (`a` = American, `b` = British)
    voices well; for non-English we yield to edge-tts since the
    quality gap there reverses.
    """
    global _KOKORO_BROKEN, _KOKORO_BROKEN_REASON
    if _KOKORO_BROKEN:
        return None
    lang = (language or "en").lower()[:2]
    if lang != "en":
        log.info(f"Kokoro skipped for language={lang} (English-only model); using edge-tts.")
        return None
    # Preflight: if there's a CUDA device but its compute capability is
    # below 7.0 (Kaggle P100 = sm_6.0), Kokoro will .to('cuda') and
    # blow up with cudaErrorNoKernelImageForDevice. Skip immediately —
    # edge-tts still ships this run.
    try:
        import torch as _torch
        if _torch.cuda.is_available():
            try:
                from modules import gpu_topology as _gt
                _kdev = _gt.kokoro_device if _gt.kokoro_device is not None else 0
            except Exception:
                _kdev = 0
            _cap = _torch.cuda.get_device_capability(_kdev)
            if _cap[0] < 7:
                _KOKORO_BROKEN = True
                _KOKORO_BROKEN_REASON = (
                    f"cuda:{_kdev} compute capability sm_{_cap[0]}.{_cap[1]} is "
                    f"below sm_7.0 — modern PyTorch wheels don't ship kernels "
                    f"for it (edge-tts used instead)"
                )
                log.info(f"Kokoro skipped: {_KOKORO_BROKEN_REASON}")
                return None
    except Exception:
        pass   # if we can't even probe torch, fall through to the normal try/except
    try:
        import time
        from kokoro import KPipeline
        import soundfile as sf
        import numpy as np

        cfg = _voice_config(channel_type, language=language)
        voice_id = cfg["kokoro"]
        speed = cfg.get("kokoro_speed", 0.95)
        word_count = len(text.split())
        log.info(
            f"Generating TTS with Kokoro | voice={voice_id} speed={speed} "
            f"words={word_count} | CPU inference is slow — expect ~"
            f"{max(20, word_count // 3)}s; budget={KOKORO_WALL_CLOCK_BUDGET_SECONDS}s"
        )

        pipeline = KPipeline(lang_code="a")  # 'a' = American English
        # On T4x2, pin Kokoro to cuda:1 so it doesn't compete with SDXL
        # warm on cuda:0 during step [3/6]. On T4x1 this is a no-op —
        # kokoro_device resolves to cuda:0 (where it would have landed
        # anyway). Kokoro doesn't expose a public device API, so walk
        # the common internal attribute names; any missing attr is a
        # safe no-op on a newer/older Kokoro release.
        try:
            from modules import gpu_topology as _gt
            _kd = _gt.kokoro_device
            if _kd is not None and _kd != 0:
                _dev_str = f"cuda:{_kd}"
                _moved_any = False
                for _attr in ("model", "tts_model", "kmodel",
                              "voice_encoder", "encoder"):
                    _obj = getattr(pipeline, _attr, None)
                    if _obj is not None and hasattr(_obj, "to"):
                        try:
                            # .float() after .to() forces the model to
                            # fp32. Kokoro creates its input tensors in
                            # torch's default dtype (fp32), so a Half
                            # model mismatches on the first op with
                            # "Input and parameter tensors are not the
                            # same dtype, found input tensor with Float
                            # and parameter tensor with Half".
                            # Confirmed live on 2026-07-09. The 82M param
                            # model in fp32 is ~330 MB → fp32 makes it
                            # ~660 MB. Trivial on a 16 GB T4.
                            _obj.to(_dev_str).float()
                            _moved_any = True
                        except Exception:
                            pass
                if _moved_any:
                    log.info(f"kokoro pinned to {_dev_str} (fp32)")
        except Exception as _kex:
            log.debug(f"kokoro device pin skipped: {_kex}")
        audio_chunks = []
        # Track per-chunk grapheme text + audio length so we can emit a
        # per-word timing sidecar. Kokoro's pipeline yields tuples of
        # (graphemes, phonemes, audio). By capturing the graphemes we
        # know WHICH portion of the narration is covered by each chunk
        # of audio — enough to anchor caption timings drift-free at
        # chunk boundaries instead of estimating them globally from
        # character counts (the current source of "subtitles drift"
        # complaints — see modules/editor.plan_word_events).
        chunk_records: list[dict] = []
        SR = 24000
        start = time.time()
        for i, chunk_tuple in enumerate(pipeline(text, voice=voice_id, speed=speed), 1):
            elapsed = time.time() - start
            log.info(f"  kokoro chunk {i} done at {elapsed:.1f}s")
            # Kokoro's tuple shape has varied across releases; guard the
            # unpacking so an unexpected extra field doesn't crash the
            # whole voiceover step.
            try:
                graphemes, _phonemes, audio = chunk_tuple[0], chunk_tuple[1], chunk_tuple[2]
            except Exception:
                graphemes, _phonemes, audio = "", "", chunk_tuple[-1]
            audio_chunks.append(audio)
            try:
                _dur = float(len(audio)) / float(SR)
            except Exception:
                _dur = 0.0
            chunk_records.append({
                "graphemes": str(graphemes or "").strip(),
                "duration_s": _dur,
            })
            if elapsed > KOKORO_WALL_CLOCK_BUDGET_SECONDS:
                log.warning(
                    f"Kokoro budget exceeded ({elapsed:.0f}s > "
                    f"{KOKORO_WALL_CLOCK_BUDGET_SECONDS}s) — aborting; will fall back to edge-tts"
                )
                return None

        if audio_chunks:
            total = time.time() - start
            log.info(f"  kokoro: {len(audio_chunks)} chunks total in {total:.1f}s")
            full_audio = np.concatenate(audio_chunks)
            sf.write(output_path, full_audio, SR)
            log.info(f"Kokoro audio saved: {output_path}")
            # Emit a word-timing sidecar so the editor's caption planner
            # uses REAL chunk-anchored timings instead of the global
            # character-count heuristic. Each chunk covers a slice of
            # the narration; we distribute words within the chunk by
            # character-weight (accurate within ~50ms) and anchor chunk
            # boundaries to the actual audio playback offsets. This is
            # the same sidecar format edge-tts writes at line ~189.
            try:
                _write_kokoro_word_timing_sidecar(text, chunk_records, output_path)
            except Exception as _wex:
                log.warning(f"kokoro: word-timing sidecar not written ({_wex}); "
                            f"captions will fall back to character heuristic")
            return output_path
        # Generator yielded nothing — treat as broken so we don't try again
        # this process.
        _KOKORO_BROKEN = True
        _KOKORO_BROKEN_REASON = "KPipeline yielded zero audio chunks"
        log.warning(f"Kokoro disabled: {_KOKORO_BROKEN_REASON}")
        return None

    except ImportError as e:
        _KOKORO_BROKEN = True
        _KOKORO_BROKEN_REASON = f"ImportError: {e} (pip install kokoro soundfile)"
        log.warning(
            f"Kokoro not available ({e}); falling back to edge-tts for "
            f"this run and silently skipping for the rest. To install: "
            f"pip install kokoro soundfile"
        )
    except Exception as e:
        # DLL load failures, missing model files, GPU OOM, sm_60 kernels
        # missing, etc. — all unrecoverable for this process. Mark broken
        # so we don't try again. First failure logs a one-line reason;
        # full traceback goes to DEBUG so it's still available via a
        # log-level bump but doesn't scare users in the normal stream.
        _KOKORO_BROKEN = True
        _KOKORO_BROKEN_REASON = f"{type(e).__name__}: {str(e)[:200]}"
        log.warning(
            f"Kokoro disabled for this process ({_KOKORO_BROKEN_REASON}); "
            f"edge-tts will handle the rest of this run."
        )
        log.debug("Kokoro failure traceback:\n%s", traceback.format_exc())
    return None


def generate_voiceover(narration_text, channel_type, output_dir, language=None, voice_override=None):
    """
    Main entry point. Tries preferred engine, falls back automatically.
    Returns path to generated audio file.

    `language` is a 2-letter ISO code — "en", "ur", "hi", "es"... When
    non-English, kokoro is skipped (English-only model) and edge-tts
    picks a matching neural voice.

    `voice_override` — a specific edge-tts voice id the /create wizard
    let the user pick. Wins over niche/language defaults; ignored (with
    a warning) if its locale doesn't match `language`.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    output_path = os.path.join(output_dir, "voiceover.mp3")
    engine = (load_settings().get("voice", {}).get("engine") or "edge").lower()

    if engine == "kokoro":
        result = generate_with_kokoro(narration_text, channel_type, output_path, language=language)
        if result:
            return result
        # Kokoro is English-only — for non-English renders it returns
        # None by design, not as a failure. Log it as an INFO switch
        # rather than a scary "Kokoro failed" WARN so the log doesn't
        # imply a bug on every de/fr/es/etc. render.
        _lang = (language or "en").lower()[:2]
        if _lang != "en":
            log.info(f"Kokoro is English-only; using edge-tts for language={_lang}")
        else:
            log.warning("Kokoro failed, falling back to edge-tts")

    # Default / fallback: edge-tts
    result = generate_with_edge_tts(
        narration_text, channel_type, output_path,
        language=language, voice_override=voice_override,
    )
    return result
