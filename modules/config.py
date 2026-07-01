"""
config.py — Centralized settings + preflight checks.

Two storage layers:
  - .env  — secrets only (API keys, client_secret path). Never written by GUI.
  - config/settings.json — all tunable knobs (channel, tone, voice, video,
    upload, keyword pools). Written by the GUI; read by every module via
    settings().

settings.json is created with sensible defaults on first read. Modules call
settings() at call-time (NOT import-time) so the GUI's changes take effect
immediately on the next pipeline run, without needing a process restart.
"""
import os
import json
import shutil
import logging
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

SETTINGS_PATH = Path("config/settings.json")


def env(name, default=None):
    v = os.getenv(name, default)
    return v if v not in ("", None) else default


# ── Defaults ─────────────────────────────────────────────────
# Every knob the GUI can edit lives here. Modules read via settings().get(...)
# with a fallback to these defaults if the key is missing.
DEFAULT_SETTINGS = {
    "content": {
        "channel": env("CHANNEL_TYPE", "horror"),  # "horror" | "wisdom"
        # chilling = dread-first horror; the default that fits a horror channel.
        # Set to "atmospheric" / "extreme" / "dramatic" via the GUI for variety.
        "tone": "chilling",
        "target_word_min": 160,
        "target_word_max": 200,
        "manual_premise": "",                      # if set, overrides auto-generated premise
        "videos_per_run": int(env("VIDEOS_PER_RUN", "1")),
    },
    "voice": {
        "engine": env("TTS_ENGINE", "edge").lower(),  # "edge" | "kokoro"
        "edge_voice_horror": "en-US-BrianMultilingualNeural",
        "edge_voice_wisdom": "en-US-AndrewMultilingualNeural",
        "edge_rate_horror": "-5%",
        "edge_pitch_horror": "-2Hz",
        "edge_rate_wisdom": "+0%",
        "edge_pitch_wisdom": "+0Hz",
        "kokoro_voice_horror": "am_michael",
        "kokoro_voice_wisdom": "am_adam",
        "kokoro_speed_horror": 0.9,
        "kokoro_speed_wisdom": 0.95,
    },
    "video": {
        "min_segment_seconds": 2.0,
        "max_segment_seconds": 7.0,
        # Master switches for source media types. With video clips off, the
        # pipeline runs as an "animated stills" montage — only image sources
        # are fetched and the cinematic motion effects do the heavy lifting.
        "use_video_clips": True,
        "allow_images": True,
        "music_base_volume": 0.55,
        "music_duck_ratio": 4.0,
        "music_duck_threshold": 0.15,
        "caption_highlight_color_bgr": "00FFFF",   # yellow (ASS BGR)
        "caption_font_size": 72,
        "caption_highlight_size": 90,
        # AI image generation (Pollinations text-to-image, free no-key).
        # 0 = disabled. Each image takes ~5-30s; budget accordingly.
        "ai_image_count": 0,
        "ai_image_style": "",   # empty = channel-appropriate default in footage.py
        # Cinematic image effects applied to ALL still-image segments.
        # intensity 0 = no effects, 1 = strong (vignette + grain + grade + bigger zoom).
        "effects_intensity": 0.7,
        # Vision-gated Shutterstock licensing:
        # Before burning quota on a Shutterstock license, send the watermarked
        # preview to a NIM vision model and only license images that score
        # >= vision_judge_threshold. Saves quota on poor matches.
        # Output encoder settings. CRF is the quality knob — lower = bigger
        # file + higher quality. For YouTube Shorts of stock-photo montage:
        #   18-20 = visually lossless, file ~50-80 MB for 60s    (overkill)
        #   23    = "high quality" (YouTube's recommendation)    (default)
        #   26    = noticeably compressed but still fine
        #   28+   = visible blockiness on motion
        # Preset trades encode time for compression: fast/medium/slow.
        # "medium" gives ~25% smaller files than "fast" at the same CRF.
        "output_crf": 23,
        "output_preset": "medium",
        "output_audio_bitrate": "96k",
        # Per-segment render pipeline.
        #   "auto" — use the GPU renderer (modules/editor_gpu) when torch.cuda
        #            is available AND the editor_gpu module imported successfully.
        #            Falls back to the ffmpeg path per-segment on any failure.
        #   "gpu"  — force GPU; if torch.cuda is missing the job will still
        #            silently fall back to ffmpeg (we never hard-fail on this).
        #   "cpu"  — force the existing ffmpeg-only path. Use this if you hit
        #            a GPU regression and want a clean rollback.
        "render_pipeline": "auto",
        # Cap intermediate buffer height in the GPU path. T4 has 16 GB VRAM
        # so 1920 is fine, but smaller cards or extra-long segments can OOM
        # on very tall buffers; the GPU renderer clamps to this and lets
        # interpolation do the final upscale to the output 1080×1920.
        "gpu_oom_safe_height": 1920,
        # Per-shot AI image generation: how many polished prompts (with
        # rotating camera angles) we try before falling back to the best
        # below-threshold result.
        "ai_image_attempts_per_shot": 3,
        "vision_judge_enabled": True,
        # Threshold is intentionally low — the 11b vision model is more
        # reliable at RANKING than absolute scoring. We over-fetch
        # candidates and let the model surface the best of the batch; the
        # threshold filters only truly off-genre images.
        "vision_judge_threshold": 4,
        "vision_judge_candidates_multiplier": 4,  # search 4x what we need
        # Content restrictions for footage providers.
        # When False (default for horror channel), the local adult-term
        # denylist is bypassed and server-side safe filters are loosened
        # so gothic-horror imagery (decay, occult, dark anatomy) isn't
        # over-filtered. Hardcore porn is still blocked at the provider
        # level even with this off — providers have their own permanent floor.
        "content_restrictions": False,
    },
    # Per-provider on/off toggles. Disabled providers are completely skipped
    # by get_footage, so you can lean into the one or two that work best for
    # your style without dropping their API key.
    "providers": {
        "shutterstock":    True,   # premium image source, 500/month free tier
        "pexels":          True,
        "coverr":          True,
        "pixabay":         True,
        "openverse_image": True,
        "pollinations":    True,   # free AI image gen — primary fallback (no key needed)
        "huggingface":     True,   # free AI image gen — robust second fallback (needs HF_TOKEN)
    },
    # AI image generation — 3 providers with user-configurable priority
    # order + per-provider toggles + a shared negative prompt.
    # `priority` is walked left-to-right; a disabled or key-less provider
    # is skipped. Each provider has its own retry/breaker inside shotfinder.
    # Keys/tokens flow through the api_keys collection or worker env; the
    # UI toggle just gates whether we EVEN TRY the provider.
    "image_gen": {
        "priority": ["huggingface", "local_sdxl", "pollinations"],
        "enabled": {
            "huggingface": True,
            "local_sdxl":  True,
            "pollinations": True,
        },
        # `local_sdxl` uses diffusers on the worker's own GPU (T4/P100 on
        # Colab or Kaggle). Free, fast (~5-8 sec/image), no rate limits,
        # native negative-prompt support. Model default fits comfortably
        # in 8 GB VRAM. Override with LOCAL_SDXL_MODEL env if you want a
        # different HF-repo checkpoint.
        "local_sdxl_model": "stabilityai/sdxl-turbo",
        # How many shots to fetch in parallel. Each worker thread runs
        # one shot's full provider chain end-to-end. Raise to use more
        # VRAM (SDXL at 1024x576 ~ 4-5 GB/shot on P100). Cap 6 for
        # sanity — beyond that HF Inference rate-limits + Pollinations
        # circuit-breakers kick in. Default 3 → ~12-15 GB VRAM on P100
        # / T4 16 GB, ~3x faster storyboard fetch step.
        "shot_parallelism": 3,
        # Applied to every provider that has a native negative_prompt
        # parameter (HF SDXL, local SDXL). For Pollinations Flux we
        # append a "avoid:" clause to the prompt since Flux has no
        # separate negative field. Empty string disables.
        "negative_prompt": (
            "worst quality, low quality, blurry, out of focus, distorted anatomy, "
            "extra limbs, malformed hands, missing fingers, mangled face, "
            "asymmetric eyes, low res, jpeg artifacts, watermark, signature, "
            "text, logo, cropped, frame, border, cartoon, 3d render, cgi"
        ),
    },
    "upload": {
        "privacy": env("YOUTUBE_PRIVACY", "public").lower(),  # public|unlisted|private
        "made_for_kids": False,
        "category_horror": "24",  # Entertainment
        "category_wisdom": "27",  # Education
    },
    "keywords": {
        # Gothic-horror fallback pool — used only when the LLM's
        # story-specific keywords don't yield enough material. Each phrase is
        # deliberately cinematic, dread-evoking, and search-engine-friendly
        # on stock libraries.
        "horror": [
            "abandoned gothic mansion at night",
            "decrepit asylum corridor flickering light",
            "foggy graveyard moonlight wrought iron",
            "candlelit dark hallway shadows",
            "abandoned victorian doll on chair",
            "old cathedral interior fog",
            "shadowy figure end of long hallway",
            "rusted hospital morgue empty",
            "occult symbols carved wood",
            "ouija board candlelight dust",
            "withered tree branches in fog",
            "moonlit cemetery iron gates",
            "decaying wallpaper peeling old room",
            "dim attic dust motes light beam",
            "abandoned cabin in dark woods",
        ],
        "wisdom": [
            "sunrise nature", "city timelapse", "ocean waves",
            "mountain peak", "people walking",
        ],
    },
    "music_keywords": {
        "horror": "dark ambient horror",
        "wisdom": "inspirational background music",
    },
}


def _deep_merge(base, overrides):
    """Merge nested dict overrides into base (overrides wins). Returns new dict."""
    out = dict(base)
    for k, v in (overrides or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_settings():
    """Read settings.json (creating it from defaults if missing). Returns dict."""
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not SETTINGS_PATH.exists():
        # Fresh container — write defaults to LOCAL file only. We MUST NOT
        # push to Firestore here: that would clobber the user's saved
        # settings before settings_sync.pull_into_local() (called from the
        # server startup hook) gets a chance to hydrate them. See
        # backend/server.py startup → settings_sync.pull_into_local().
        save_settings(DEFAULT_SETTINGS, _bootstrap=True)
        return dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            user = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        log.warning(f"settings.json unreadable ({e}); using defaults")
        return dict(DEFAULT_SETTINGS)
    # Merge over defaults so any newly-added keys appear without breaking
    # existing config files.
    return _deep_merge(DEFAULT_SETTINGS, user)


def save_settings(data, *, _bootstrap: bool = False):
    """Atomic write of settings.json, then mirror to remote storage so
    the value survives container restarts on Colab/HF Space. The remote
    push is best-effort and non-fatal; the local write is the source
    of truth for the running process.

    _bootstrap=True: write the local file only. Used by load_settings()
    when seeding a fresh container with DEFAULT_SETTINGS — pushing those
    defaults to Firestore would overwrite the user's last saved values.
    """
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SETTINGS_PATH)

    if _bootstrap:
        return

    # Lazy import: backend.* depends on modules.config at import time,
    # so we can't import it at module level (circular). Importing inside
    # the function only triggers when save is actually called.
    try:
        from backend import settings_sync
        settings_sync.push_from_local()
    except Exception as e:
        log.debug(f"save_settings: remote mirror skipped ({e})")


def settings():
    """Convenience: load + return the current settings dict."""
    return load_settings()


# ── Back-compat module-level constants (read once at import) ─────────
# These remain so older code paths still work, but new code should call
# settings() at call-time for live updates from the GUI.
_S = load_settings()
CHANNEL_TYPE   = _S["content"]["channel"]
VIDEOS_PER_RUN = _S["content"]["videos_per_run"]
TTS_ENGINE     = _S["voice"]["engine"]
PRIVACY        = _S["upload"]["privacy"]


def reload():
    """Re-read settings.json and refresh the module-level constants.

    The /api/settings handler calls this after settings_sync hydrates
    the local file from R2/SFTP at startup — otherwise the constants
    above stay at whatever was on disk at import time (defaults on a
    fresh container)."""
    global _S, CHANNEL_TYPE, VIDEOS_PER_RUN, TTS_ENGINE, PRIVACY
    _S = load_settings()
    CHANNEL_TYPE   = _S["content"]["channel"]
    VIDEOS_PER_RUN = _S["content"]["videos_per_run"]
    TTS_ENGINE     = _S["voice"]["engine"]
    PRIVACY        = _S["upload"]["privacy"]
    return _S
if PRIVACY not in ("public", "unlisted", "private"):
    log.warning(f"privacy={PRIVACY!r} invalid; falling back to 'private'")
    PRIVACY = "private"


# ── API keys (read lazily by modules; we just collect for preflight) ──
# LLM: NIM (Nemotron) is primary, Groq is fallback — either alone is enough.
_LLM_ANY_OF = ["NVIDIA_NIM_API_KEY", "GROQ_API_KEY"]
# Footage: Shutterstock / Pexels / Pixabay / Coverr are stock sources.
# Pollinations AI image generation is the free fallback and needs no key,
# so footage is *advisory*, not required — pipeline still runs without any.
_FOOTAGE_ANY_OF = [
    "SHUTTERSTOCK_API_TOKEN", "SHUTTERSTOCK_CLIENT_ID",
    "PEXELS_API_KEY", "PIXABAY_API_KEY", "COVERR_API_KEY",
]


class PreflightError(RuntimeError):
    pass


def preflight(skip_upload=False):
    """
    Verify the run can succeed before we start spending time/quota.
    Raises PreflightError with a clear message if anything is missing.
    """
    problems = []
    warnings = []

    if not any(env(n) for n in _LLM_ANY_OF):
        problems.append(
            "no LLM key set — need at least one of " + ", ".join(_LLM_ANY_OF)
        )

    if not any(env(n) for n in _FOOTAGE_ANY_OF):
        # Pollinations AI image gen covers the visuals without a key, so
        # this is a soft warning rather than a hard failure.
        warnings.append(
            "no stock footage key set — falling back to AI image generation "
            "(Pollinations). For richer footage set one of: "
            + ", ".join(_FOOTAGE_ANY_OF)
        )

    for binary in ("ffmpeg", "ffprobe"):
        if shutil.which(binary) is None:
            problems.append(f"{binary} not found on PATH")

    if not skip_upload:
        secrets = env("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secret.json")
        if not os.path.exists(secrets):
            problems.append(f"YouTube client_secret.json not found at {secrets}")

    if problems:
        msg = "Preflight failed:\n  - " + "\n  - ".join(problems)
        if warnings:
            msg += "\n\nAdditionally:\n  - " + "\n  - ".join(warnings)
        raise PreflightError(msg)
    if warnings:
        for w in warnings:
            log.warning(f"preflight: {w}")

    s = load_settings()
    log.info(
        f"Preflight ok | channel={s['content']['channel']} "
        f"tone={s['content']['tone']} privacy={s['upload']['privacy']} "
        f"tts={s['voice']['engine']}"
    )
