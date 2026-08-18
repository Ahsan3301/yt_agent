"""
clip_qc.py — quality-gate a generated motion clip before it ships.

Image-to-video models fail in a characteristic way: the first frame is
fine, because it was handed to them, and then somewhere in the next few
seconds a hand grows a sixth finger, a face melts, or the whole frame
smears into soup. Judging a clip by its opening frame therefore judges
the thing the model did NOT generate, and passes exactly the clips that
are broken.

So this samples LATE. It pulls frames from the back half of the clip,
where the drift lives, plus one from the middle, and scores those.

Three checks, because each catches failures the others are blind to.
The two local ones cost no API call and run always:

  1. MOTION — frame-to-frame difference on a 64px thumbnail. Answers
     one question: did the picture actually move? A frozen clip is the
     exact thing this niche must never publish. It does NOT judge
     whether the motion is coherent — see the note by STILL_THRESHOLD
     for why that turned out to be undecidable from this metric.

  2. ARTEFACTS — high-frequency energy at full resolution. This exists
     because check 1 is blind to artefacts by construction: downscaling
     to 64px averages noise away, and during calibration pure white
     noise scored 6.75 on the motion metric — indistinguishable from
     normal motion at 4.9 — and passed. Measured at full resolution the
     same clip scores 27.5 against real content's 1.8-4. Catches both
     directions of failure: a frame smeared into mush, and a frame
     broken up into noise.

  3. SEMANTICS — a vision-model score against the shot's own
     description. Catches wrong character, melted anatomy, text scrawled
     across the frame. Costs a call, and degrades to "unknown" rather
     than to "fail" when the model is unreachable: a scoring outage must
     not reject every clip in the render.

Every threshold below was measured against synthetic clips rather than
guessed, and the numbers are recorded beside each constant.

Verdicts are advisory to the caller. This module decides whether a clip
is good; the caller decides what to do about it.
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile

log = logging.getLogger(__name__)

# Below this, consecutive sampled frames are effectively identical and
# the "video" is a still — the exact failure this niche cannot ship.
# Mean absolute difference over 0-255 channels.
#
# MEASURED: a frozen clip scores 0.00; the verified-good real clip
# scored 6.33 on its quietest pair and 56.40 on its busiest. 2.0 sits in
# open space between them, and also catches the "technically moving but
# nothing is happening" clip that a 1.2 would have passed.
STILL_THRESHOLD = 2.0

# NO CHAOS THRESHOLD — deliberately.
#
# There was one, at 11.0, calibrated against synthetic clips. Then the
# first REAL image-to-video clip arrived: a terrier trotting toward the
# camera, verified good frame by frame, character perfectly consistent.
# Its pairwise frame deltas were 39.2, 56.4, 35.0, 6.3 — mean 34.2, or
# three times the threshold. It was rejected.
#
# The synthetic calibration was measuring the wrong thing. Test patterns
# have a static camera, so almost nothing moves between frames. A real
# clip where the subject approaches the lens legitimately replaces most
# of the frame, and scores higher than cellular-automaton churn (11.3)
# or a hue strobe (13.1) ever did. There is no threshold that passes the
# good clip and fails the synthetic bad ones — they overlap completely,
# in the wrong direction.
#
# So frame-differencing keeps the job it is genuinely good at — telling
# a moving clip from a frozen one, where the separation is 0.00 against
# 6.3-56.4 — and incoherence is left to the artefact check and the
# vision model, which look at what a frame CONTAINS rather than at how
# much of it changed. A high delta is now logged, never rejected.
#
# Known gap, stated rather than hidden: a hue-cycling strobe (delta
# 13.1, detail 2.85) now passes both local checks. It is caught only by
# the vision model. Accepted, because rejecting real motion is the far
# more expensive error — every regeneration costs ~90s and a slot
# against the provider's queue.

# High-frequency energy, measured at full resolution (mean |pixel -
# gaussian blur|). This is the artefact detector, and it exists because
# frame-differencing cannot see artefacts at all: downscaling to 64px
# averages noise away, which is why pure white noise scored 6.75 on the
# motion metric and sailed through as "ok" during calibration.
#
# MEASURED on the same clips:
#   heavy box blur (smeared mush)   0.45
#   SMPTE bars                      1.87
#   hue strobe                      2.85
#   gentle zoom                     3.07
#   normal motion                   3.83
#   heavy added grain               6.65
#   cellular churn                 25.08
#   pure white noise               27.49
# Real content lands in 1.8-4. Below the floor the frame has dissolved
# into mush; above the ceiling it has broken up into noise. Grain at
# 6.65 deliberately passes — it is ugly but it is still a picture, and
# the vision model is a better judge of that than a threshold.
HF_MUSH_MAX = 0.9
HF_NOISE_MIN = 12.0

# Vision score, 0-10, below which a clip is considered a miss.
DEFAULT_MIN_VISION = 5


def _ffmpeg() -> str:
    return os.getenv("FFMPEG_BINARY", "ffmpeg")


def duration_seconds(path: str) -> float:
    """Real duration of a media file, or 0.0 if it cannot be read."""
    try:
        out = subprocess.run(
            [os.getenv("FFPROBE_BINARY", "ffprobe"), "-v", "error",
             "-show_entries", "format=duration", "-of",
             "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float((out.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def extract_frames(path: str, at_seconds: list[float], out_dir: str) -> list[str]:
    """Grab one JPEG per timestamp. Returns the paths that worked."""
    made: list[str] = []
    for i, t in enumerate(at_seconds):
        dest = os.path.join(out_dir, f"qc_{i:02d}.jpg")
        try:
            subprocess.run(
                [_ffmpeg(), "-y", "-loglevel", "error",
                 "-ss", f"{max(0.0, t):.3f}", "-i", path,
                 "-frames:v", "1", "-q:v", "3", dest],
                capture_output=True, timeout=60,
            )
            if os.path.exists(dest) and os.path.getsize(dest) > 1024:
                made.append(dest)
        except Exception as e:
            log.debug(f"clip_qc: frame at {t:.2f}s failed: {e}")
    return made


def hf_energy(path: str) -> float:
    """High-frequency energy of one frame — the artefact metric.

    Deliberately computed at up to 512px rather than on the 64px
    thumbnail the motion check uses: the whole point is to see detail
    that downscaling destroys. Sampled every second pixel to keep it
    cheap on a worker that is busy with diffusion.
    """
    try:
        from PIL import Image, ImageFilter
        with Image.open(path) as im:
            g = im.convert("L")
            if max(g.size) > 512:
                g = g.resize((g.width * 512 // max(g.size),
                              g.height * 512 // max(g.size)))
            b = g.filter(ImageFilter.GaussianBlur(2))
            pg, pb = g.load(), b.load()
            total, n = 0, 0
            for y in range(0, g.height, 2):
                for x in range(0, g.width, 2):
                    total += abs(pg[x, y] - pb[x, y])
                    n += 1
            return total / max(1, n)
    except Exception as e:
        log.debug(f"clip_qc: hf_energy failed: {e}")
        return -1.0


def artefact_verdict(frames: list[str]) -> tuple[str, float]:
    """('ok'|'mush'|'noise'|'unknown', mean_high_frequency_energy)."""
    vals = [v for v in (hf_energy(f) for f in frames) if v >= 0]
    if not vals:
        return "unknown", -1.0
    mean = sum(vals) / len(vals)
    if mean < HF_MUSH_MAX:
        return "mush", mean
    if mean > HF_NOISE_MIN:
        return "noise", mean
    return "ok", mean


def _mean_abs_diff(a_path: str, b_path: str) -> float:
    """Mean absolute per-pixel difference between two frames, 0-255.

    Uses PIL rather than numpy-on-GPU deliberately: this runs once per
    clip on a worker that is already saturated with diffusion work, and
    the images are downscaled to 64px first, so it costs microseconds.
    """
    try:
        from PIL import Image
        with Image.open(a_path) as ia, Image.open(b_path) as ib:
            a = ia.convert("L").resize((64, 64))
            b = ib.convert("L").resize((64, 64))
            pa, pb = a.load(), b.load()
            total = 0
            for y in range(64):
                for x in range(64):
                    total += abs(pa[x, y] - pb[x, y])
            return total / (64.0 * 64.0)
    except Exception as e:
        log.debug(f"clip_qc: frame diff failed: {e}")
        return -1.0


def motion_verdict(frames: list[str]) -> tuple[str, float]:
    """('ok'|'still'|'unknown', mean_difference).

    There is no 'chaos' verdict — see the note by STILL_THRESHOLD. This
    answers one question only: did the picture move?
    """
    if len(frames) < 2:
        return "unknown", -1.0
    diffs = [
        d for d in (_mean_abs_diff(frames[i], frames[i + 1])
                    for i in range(len(frames) - 1))
        if d >= 0
    ]
    if not diffs:
        return "unknown", -1.0
    mean = sum(diffs) / len(diffs)
    if mean < STILL_THRESHOLD:
        return "still", mean
    return "ok", mean


def vision_verdict(frames: list[str], fit_description: str, premise: str = "") -> int:
    """Median vision score across the sampled frames, or -1 if unknown.

    This took the WORST score, on the reasoning that one melted frame is
    visible to a viewer and averaging would hide it. That reasoning is
    sound and the implementation was still wrong, because it assumes the
    judge is reliable per-frame.

    It is not. Measured on a real render: two clips of a terrier
    trotting down a wet cobbled street — verified good by eye, correct
    character, correct style, no artefacts — were scored 1/10 and
    rejected. With `min` over four frames, ONE noisy score from the
    judge rejects the clip, and a regeneration costs ~90s plus a slot
    in the provider's queue.

    The median needs the judge to dislike MOST of the clip before it
    rejects, which is the claim we actually want to act on. A genuinely
    broken clip is broken in most of its frames; a single outlier is
    usually the judge, not the video.

    All per-frame scores are logged, so a systematically harsh judge is
    visible in the render log rather than showing up as a mysteriously
    degraded run.
    """
    try:
        from modules import nim
        if not nim.is_available():
            return -1
    except Exception:
        return -1

    import base64
    scores: list[int] = []
    for f in frames:
        try:
            with open(f, "rb") as fh:
                b64 = base64.b64encode(fh.read()).decode("ascii")
            sc = nim.vision_score(
                f"data:image/jpeg;base64,{b64}",
                fit_description=fit_description, premise=premise,
            )
            if isinstance(sc, int) and sc >= 0:
                scores.append(sc)
        except Exception as e:
            log.debug(f"clip_qc: vision score failed on {os.path.basename(f)}: {e}")
    if not scores:
        return -1
    scores.sort()
    median = scores[len(scores) // 2]
    log.info("clip_qc: vision scores %s -> median %d", scores, median)
    return median


def check(path: str, fit_description: str = "", premise: str = "",
          min_vision: int = DEFAULT_MIN_VISION,
          use_vision: bool = True) -> dict:
    """Judge one clip.

    Returns {ok, reason, motion, mean_diff, vision, duration}. `ok` is
    False only on a POSITIVE finding of a problem — an unreadable clip
    or an unreachable vision model returns ok=True with the reason
    recorded, because refusing to publish over a failed check is a
    different decision from refusing to publish over a failed clip, and
    only the caller knows which it wants.
    """
    result = {"ok": True, "reason": "", "motion": "unknown",
              "mean_diff": -1.0, "artefact": "unknown", "hf": -1.0,
              "vision": -1, "duration": 0.0}
    if not path or not os.path.exists(path):
        result.update(ok=False, reason="clip missing")
        return result

    dur = duration_seconds(path)
    result["duration"] = round(dur, 2)
    if dur <= 0.4:
        result.update(ok=False, reason=f"clip is only {dur:.2f}s")
        return result

    with tempfile.TemporaryDirectory(prefix="clipqc_") as tmp:
        # Weighted to the back half — that is where a video model loses
        # coherence. 0.15 is included only as the "before" half of the
        # first difference pair.
        stamps = [dur * f for f in (0.15, 0.5, 0.72, 0.88, 0.97)]
        frames = extract_frames(path, stamps, tmp)
        if len(frames) < 2:
            result.update(reason="could not sample frames")
            return result

        motion, mean = motion_verdict(frames)
        result["motion"] = motion
        result["mean_diff"] = round(mean, 2)
        if motion == "still":
            result.update(ok=False, reason=f"no motion (frame delta {mean:.2f})")
            return result
        if mean > 45.0:
            # Observation, not a verdict. Big deltas are normal when the
            # subject approaches the lens; the verified-good reference
            # clip peaked at 56.4 on one pair.
            log.info(f"clip_qc: high frame delta {mean:.1f} — fast motion or a cut")

        art, hf = artefact_verdict(frames[1:])
        result["artefact"] = art
        result["hf"] = round(hf, 2)
        if art == "mush":
            result.update(ok=False, reason=f"frame has smeared into mush (detail {hf:.2f})")
            return result
        if art == "noise":
            result.update(ok=False, reason=f"frame broke up into noise (detail {hf:.2f})")
            return result

        if use_vision and fit_description:
            # Score the late frames only. The 0.15 sample exists for the
            # motion pair; spending a vision call on it would be paying
            # to check the frame the model was handed.
            v = vision_verdict(frames[1:], fit_description, premise)
            result["vision"] = v
            if v >= 0 and v < min_vision:
                result.update(ok=False, reason=f"vision score {v}/10 below {min_vision}")
                return result
            if v < 0:
                result["reason"] = "vision scoring unavailable — motion check only"

    return result
