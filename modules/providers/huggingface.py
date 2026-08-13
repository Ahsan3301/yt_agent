"""Hugging Face Inference - SDXL with a real negative prompt.

Self-contained: breaker state, generate body and the run-start reset.

Two readiness conditions, in this order: token, then breaker. The token
comes first for the same reason as cloudflare's credential check —
reporting "120s remaining" when the real problem is a missing token
sends someone to wait instead of to the keys page.

The token is genuinely required here, unlike horde's optional priority
key: without HF_TOKEN the endpoint refuses every request, so skipping
early saves five useless round trips per shot.

Notably this provider does NOT run the prompt through the distiller.
It takes a real negative_prompt parameter rather than folding negatives
into the positive prompt, and it is pointed at SDXL rather than Flux —
so the natural-language shaping the distiller now does for klein is not
what this backend wants.

HF_INFERENCE_PROVIDER can route through replicate/fal instead of
hf-inference. Read inside the body, not in ready(): it changes WHERE
the request goes, not WHETHER it can be made.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
import requests

from modules.providers.base import Provider, register

log = logging.getLogger(__name__)


# ── HuggingFace Inference API (free fallback when Pollinations is rate-limited) ─
# Same breaker pattern as Pollinations. HF returns image bytes directly.
# Default model is SDXL base 1.0 — fast and gives decent horror/cinematic.
_HF_CONSECUTIVE_FAILS = 0
_HF_OPEN_UNTIL = 0.0
_HF_BACKOFF_THRESHOLD = 3
_HF_OPEN_FOR_SECONDS = 120

_HF_DEFAULT_MODEL = "stabilityai/stable-diffusion-xl-base-1.0"


def _hf_model() -> str:
    """Model id, read at CALL time.

    This was a module-level os.getenv, which freezes whatever was set
    when the worker booted. keys_sync rewrites the environment per job,
    so an operator changing HF_IMAGE_MODEL in the credential store would
    have seen no effect until the container restarted — the same
    import-time capture that disabled Agnes on every render and that the
    horde blurb nearly repeated.
    """
    return (os.getenv("HF_IMAGE_MODEL", "") or "").strip() or _HF_DEFAULT_MODEL


def _hf_breaker_skip():
    return time.time() < _HF_OPEN_UNTIL


def _hf_breaker_record(success: bool, http_status: int | None = None):
    global _HF_CONSECUTIVE_FAILS, _HF_OPEN_UNTIL
    if success:
        if _HF_CONSECUTIVE_FAILS:
            log.info("HuggingFace: circuit breaker reset after successful call")
        _HF_CONSECUTIVE_FAILS = 0
        return
    # Any failure (5xx, 429, network) counts. Trip the breaker on N
    # consecutive fails so we don't hammer a sick service.
    _HF_CONSECUTIVE_FAILS += 1
    if _HF_CONSECUTIVE_FAILS >= _HF_BACKOFF_THRESHOLD:
        _HF_OPEN_UNTIL = time.time() + _HF_OPEN_FOR_SECONDS
        log.warning(
            f"HuggingFace: circuit breaker OPEN — {_HF_CONSECUTIVE_FAILS} "
            f"consecutive failures (status={http_status}); skipping for "
            f"{_HF_OPEN_FOR_SECONDS}s"
        )


def reset_hf_breaker():
    global _HF_CONSECUTIVE_FAILS, _HF_OPEN_UNTIL
    _HF_CONSECUTIVE_FAILS = 0
    _HF_OPEN_UNTIL = 0.0


def _huggingface_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via HF Inference API. Returns (path, seed) on
    success, (None, seed) on failure. Honours its own circuit breaker.

    Needs HF_TOKEN env var. Token is free at
    https://huggingface.co/settings/tokens (Read scope is enough).
    negative_prompt is passed to SDXL as a real parameter (native
    support), unlike Pollinations Flux which has no negative field."""
    token = os.getenv("HF_TOKEN", "").strip()
    seed = int(hashlib.md5(f"{prompt}|{trial}|hf".encode()).hexdigest()[:8], 16)
    if not token:
        return None, seed
    if _hf_breaker_skip():
        wait = int(_HF_OPEN_UNTIL - time.time())
        log.info(f"HuggingFace: breaker OPEN (skipping; reopens in {wait}s)")
        return None, seed

    dest = os.path.join(output_dir, f"huggingface_{seed:08x}.jpg")
    # HuggingFace shut down api-inference.huggingface.co in mid-2025 when
    # they rebranded to Inference Providers. The domain no longer resolves
    # at all (DNS NXDOMAIN). New endpoint is under router.huggingface.co,
    # backed by the hf-inference provider by default. Configurable via
    # HF_INFERENCE_PROVIDER env in case the user wants replicate/fal via
    # HF's routing layer instead.
    provider = os.getenv("HF_INFERENCE_PROVIDER", "hf-inference").strip() or "hf-inference"
    url = f"https://router.huggingface.co/{provider}/models/{_hf_model()}"
    try:
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                # Wait for model to warm up rather than 503 immediately —
                # HF caches models in memory after a few requests.
                "x-wait-for-model": "true",
                # Get a fresh image, not a cached one for the same prompt.
                "x-use-cache": "false",
            },
            json={
                "inputs": prompt,
                "parameters": {
                    # SDXL natively wants 1024x1024; we resize later. 9:16
                    # generation is supported but quality drops at extreme
                    # aspects, so stay square and crop in the editor.
                    "width": 1024,
                    "height": 1024,
                    "guidance_scale": 7.5,
                    "num_inference_steps": 25,
                    "seed": seed,
                    # Native negative-prompt support on SDXL. Empty string
                    # is fine — the API treats it the same as omitting.
                    "negative_prompt": negative_prompt or "",
                },
                "options": {"wait_for_model": True},
            },
            timeout=120,
        )
        if r.status_code == 429:
            _hf_breaker_record(success=False, http_status=429)
            log.warning("HuggingFace 429 — rate limited")
            return None, seed
        if r.status_code == 503:
            # Model still loading — short wait + breaker bump
            _hf_breaker_record(success=False, http_status=503)
            log.info("HuggingFace 503 — model loading, will retry next shot")
            return None, seed
        r.raise_for_status()
        # HF returns raw image bytes (jpeg or png).
        with open(dest, "wb") as f:
            f.write(r.content)
        if not os.path.exists(dest) or os.path.getsize(dest) < 4096:
            _hf_breaker_record(success=False)
            log.warning("HuggingFace returned <4 KB file — treating as failure")
            return None, seed
        _hf_breaker_record(success=True)
        return dest, seed
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        _hf_breaker_record(success=False, http_status=status)
        log.warning(f"HuggingFace gen failed (HTTP {status}): {e}")
        return None, seed
    except Exception as e:
        _hf_breaker_record(success=False)
        log.warning(f"HuggingFace gen failed: {e}")
        return None, seed

def _ready() -> "tuple[bool, str]":
    # Read at call time, never cached at import - keys_sync rewrites the
    # environment per job.
    if not (os.getenv("HF_TOKEN", "") or "").strip():
        return False, "no HF_TOKEN"
    if _hf_breaker_skip():
        wait = int(_HF_OPEN_UNTIL - time.time())
        return False, f"breaker open after repeated failures ({max(0, wait)}s remaining)"
    return True, ""


def _generate(prompt, output_dir, trial, negative_prompt="", **_):
    return _huggingface_generate(prompt, output_dir, trial, negative_prompt=negative_prompt)


register(Provider(
    name="huggingface",
    kind="image",
    generate=_generate,
    ready=_ready,
    supports_reference=False,
    blurb="SDXL via Hugging Face Inference. Takes a real negative_prompt "
          "rather than folding negatives into the positive one, so it is "
          "the better choice when a shot needs specific exclusions.",
))
