"""
voiceover.py — Text-to-Speech Module
Primary:  edge-tts  (Microsoft neural voices, free, no API key)
Fallback: kokoro    (local model, best quality, requires pip install kokoro)

edge-tts voices for horror: en-US-GuyNeural, en-US-ChristopherNeural
edge-tts voices for wisdom: en-US-AndrewNeural, en-GB-RyanNeural
"""
import os
import asyncio
import logging
from pathlib import Path
from dotenv import load_dotenv

from modules._net import retry
from modules.config import load_settings

load_dotenv()
log = logging.getLogger(__name__)


def _voice_config(channel_type):
    """Build the per-channel voice config dict from settings.json."""
    s = load_settings().get("voice", {})
    ch = channel_type if channel_type in ("horror", "wisdom") else "horror"
    return {
        "edge":         s.get(f"edge_voice_{ch}",  "en-US-BrianMultilingualNeural"),
        "edge_rate":    s.get(f"edge_rate_{ch}",   "-5%"),
        "edge_pitch":   s.get(f"edge_pitch_{ch}",  "-2Hz"),
        "kokoro":       s.get(f"kokoro_voice_{ch}", "am_michael"),
        "kokoro_speed": float(s.get(f"kokoro_speed_{ch}", 0.9)),
    }


# Edge-tts hits a Microsoft WebSocket. When the connection wedges (proxy,
# flaky network, server hiccup) `communicate.save()` will hang forever with
# no exception. A hard asyncio timeout forces it to raise so retry() can
# catch and move on instead of stalling the entire pipeline.
EDGE_TTS_TIMEOUT = 90  # seconds per attempt — generous; normal runs take 5-15s


async def _edge_tts_async(text, voice, output_path, rate="+0%", pitch="+0Hz"):
    """Generate audio using edge-tts (async). Supports rate/pitch prosody."""
    import edge_tts
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await asyncio.wait_for(communicate.save(output_path), timeout=EDGE_TTS_TIMEOUT)


def generate_with_edge_tts(text, channel_type, output_path):
    """
    Generate voiceover using Microsoft edge-tts (free, no key needed).
    Returns path to .mp3 file.
    """
    cfg = _voice_config(channel_type)
    voice = cfg["edge"]
    rate = cfg.get("edge_rate", "+0%")
    pitch = cfg.get("edge_pitch", "+0Hz")
    log.info(f"Generating TTS with edge-tts | voice={voice} rate={rate} pitch={pitch} (timeout={EDGE_TTS_TIMEOUT}s/attempt)")
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

# Cap kokoro generation. On a low-power CPU (i5-8265U class) a ~170-word
# narration legitimately takes 60-120s; anything past 4 min is a hang or
# something genuinely wrong, and falling back to edge-tts is better.
KOKORO_WALL_CLOCK_BUDGET_SECONDS = 240


def generate_with_kokoro(text, channel_type, output_path):
    """
    Generate voiceover using Kokoro-82M (local, higher quality).
    Requires: pip install kokoro soundfile
    """
    global _KOKORO_BROKEN
    if _KOKORO_BROKEN:
        return None
    try:
        import time
        from kokoro import KPipeline
        import soundfile as sf
        import numpy as np

        cfg = _voice_config(channel_type)
        voice_id = cfg["kokoro"]
        speed = cfg.get("kokoro_speed", 0.95)
        word_count = len(text.split())
        log.info(
            f"Generating TTS with Kokoro | voice={voice_id} speed={speed} "
            f"words={word_count} | CPU inference is slow — expect ~"
            f"{max(20, word_count // 3)}s; budget={KOKORO_WALL_CLOCK_BUDGET_SECONDS}s"
        )

        pipeline = KPipeline(lang_code="a")  # 'a' = American English
        audio_chunks = []
        start = time.time()
        for i, (_, _, audio) in enumerate(pipeline(text, voice=voice_id, speed=speed), 1):
            elapsed = time.time() - start
            log.info(f"  kokoro chunk {i} done at {elapsed:.1f}s")
            audio_chunks.append(audio)
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
            sf.write(output_path, full_audio, 24000)
            log.info(f"Kokoro audio saved: {output_path}")
            return output_path

    except ImportError as e:
        _KOKORO_BROKEN = True
        log.warning(f"Kokoro not available ({e}); falling back to edge-tts for this run and silently skipping for the rest.")
    except Exception as e:
        # DLL load failures, missing model files, GPU OOM, etc. — all
        # unrecoverable for this process. Mark broken so we don't try again.
        _KOKORO_BROKEN = True
        log.warning(f"Kokoro disabled for this process: {e}")
    return None


def generate_voiceover(narration_text, channel_type, output_dir):
    """
    Main entry point. Tries preferred engine, falls back automatically.
    Returns path to generated audio file.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    output_path = os.path.join(output_dir, "voiceover.mp3")
    engine = (load_settings().get("voice", {}).get("engine") or "edge").lower()

    if engine == "kokoro":
        result = generate_with_kokoro(narration_text, channel_type, output_path)
        if result:
            return result
        log.warning("Kokoro failed, falling back to edge-tts")

    # Default / fallback: edge-tts
    result = generate_with_edge_tts(narration_text, channel_type, output_path)
    return result
