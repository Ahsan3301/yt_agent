"""Pollinations - free Flux, no key required.

Self-contained: breaker state, rate limiter, generate body and the
run-start reset all live here.

This is the safety net of the image chain. No credentials and no quota
to exhaust, so it is usually the last provider that can still produce
something - which is exactly why ready() deliberately has NO credential
condition. Adding one would defeat its whole role.

reset_pollinations_breaker() is called by the pipeline at the start of
each run and is re-exported through shotfinder, so existing callers did
not have to change. It moved with the state it mutates: leaving the
resetter in one file and the state in another is the split that turns
into a stale-state bug nobody can find.
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import threading
import time
import urllib.parse
import requests

from modules import footage as F          # _restrictions_on() for the safe flag
from modules.providers.base import Provider, register
from modules.providers.prompt import _distill_prompt_for_flux

log = logging.getLogger(__name__)


# ── Pollinations circuit breaker ──────────────────────────────
# Pollinations rate-limits per ~minute. When we hit 429s we used to retry
# every shot which made things worse (hammered the same wall). The breaker:
#   • after N consecutive 429s, OPEN for OPEN_FOR seconds (skip the provider)
#   • on success, CLOSE (counter resets)
#
# State is module-level — survives across shots in one run.
_POLL_CONSECUTIVE_429 = 0
_POLL_OPEN_UNTIL = 0.0          # epoch seconds; if time.time() < this, skip
_POLL_BACKOFF_429 = 3            # consecutive 429s before tripping
_POLL_OPEN_FOR_SECONDS = 90      # how long to stay open once tripped


def _pollinations_breaker_skip():
    return time.time() < _POLL_OPEN_UNTIL


def _pollinations_breaker_record(success: bool, http_status: int | None = None):
    global _POLL_CONSECUTIVE_429, _POLL_OPEN_UNTIL
    if success:
        if _POLL_CONSECUTIVE_429:
            log.info("Pollinations: circuit breaker reset after successful call")
        _POLL_CONSECUTIVE_429 = 0
        return
    if http_status == 429:
        _POLL_CONSECUTIVE_429 += 1
        if _POLL_CONSECUTIVE_429 >= _POLL_BACKOFF_429:
            _POLL_OPEN_UNTIL = time.time() + _POLL_OPEN_FOR_SECONDS
            log.warning(
                f"Pollinations: circuit breaker OPEN — {_POLL_CONSECUTIVE_429} consecutive 429s; "
                f"skipping Pollinations for {_POLL_OPEN_FOR_SECONDS}s"
            )


# Serialise Pollinations requests across threads. The public endpoint
# returns 429 aggressively when two calls land within a few hundred ms
# of each other — which happens instantly with the ThreadPoolExecutor.
# Three consecutive 429s trips the circuit breaker for 90s and the rest
# of the shots get dropped. This lock + a 1.5 sec min-interval turns
# the parallel pool into serialised Pollinations calls (still faster
# than the OLD serial-shot code because stock lookups + other providers
# still run in parallel — only Pollinations itself is one-at-a-time).
import threading as _poll_threading
_POLL_CALL_LOCK = _poll_threading.Lock()
_POLL_LAST_CALL_AT = 0.0
_POLL_MIN_INTERVAL = 1.5


def _pollinations_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via Pollinations, respecting the circuit breaker.
    Returns (path, seed) on success, (None, seed) on any failure.

    Pollinations Flux has NO native negative_prompt parameter, so we
    append a plain-English `avoid: …` clause to the prompt. Flux's
    caption model is decent at honouring it in practice, though the
    effect is weaker than SDXL's proper negative_prompt path."""
    seed = int(hashlib.md5(f"{prompt}|{trial}".encode()).hexdigest()[:8], 16)

    if _pollinations_breaker_skip():
        wait = int(_POLL_OPEN_UNTIL - time.time())
        log.info(f"Pollinations: breaker OPEN (skipping; reopens in {wait}s)")
        return None, seed

    # Pollinations URL-encodes the prompt into a GET URL.
    # Two coordinated changes that materially improved output quality:
    #   1. DISTILL the prompt to a 15-25 word tag-style Flux prompt.
    #      Flux only weights the first ~77 tokens, so sending 500-char
    #      poetic prose caused it to truncate + hallucinate a generic
    #      image. Comma-separated subject + details + style at the end
    #      is what stable-diffusion + Flux fine-tunes were trained on.
    #   2. No negative-prompt clause — Flux via Pollinations doesn't
    #      respect it strongly, and appending it just pushed the URL
    #      past Pollinations' 500-storm threshold.
    final_prompt = _distill_prompt_for_flux(prompt)[:400]
    encoded = urllib.parse.quote(final_prompt, safe="")
    # Rotate the Pollinations model across attempts. All three verified
    # working (flux + sdxl + flux-pro) — cycling means a bad prompt on
    # flux gets retried on sdxl instead of just failing. Also gives
    # visual variety across shots so the video doesn't look monochrome.
    # trial 0 → flux, 1 → sdxl, 2 → flux-pro, 3 → flux, 4 → sdxl ...
    _POLL_MODELS = ("flux", "sdxl", "flux-pro")
    poll_model = _POLL_MODELS[trial % len(_POLL_MODELS)]
    url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=1080&height=1920&seed={seed}&model={poll_model}&nologo=true&private=true"
        f"&safe={'true' if F._restrictions_on() else 'false'}"
    )
    dest = os.path.join(output_dir, f"pollinations_{poll_model}_{seed:08x}.jpg")
    log.debug(f"Pollinations: using model={poll_model} (attempt {trial+1})")

    try:
        # Serialise across threads + enforce a min interval between
        # successive calls. Two parallel threads used to hit the endpoint
        # simultaneously, both get 429, and the breaker trips after 3 in
        # a row — killing the rest of the shots.
        global _POLL_LAST_CALL_AT
        with _POLL_CALL_LOCK:
            _now = time.time()
            gap = _now - _POLL_LAST_CALL_AT
            if gap < _POLL_MIN_INTERVAL:
                time.sleep(_POLL_MIN_INTERVAL - gap)
            _POLL_LAST_CALL_AT = time.time()
            r = requests.get(url, stream=True, timeout=120)
        if r.status_code == 429:
            _pollinations_breaker_record(success=False, http_status=429)
            log.warning("Pollinations 429 — breaker counter bumped")
            return None, seed
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        if not os.path.exists(dest) or os.path.getsize(dest) < 4096:
            _pollinations_breaker_record(success=False)
            return None, seed
        _pollinations_breaker_record(success=True)
        return dest, seed
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        _pollinations_breaker_record(success=False, http_status=status)
        log.warning(f"Pollinations gen failed (HTTP {status}): {e}")
        return None, seed
    except Exception as e:
        _pollinations_breaker_record(success=False)
        log.warning(f"Pollinations gen failed: {e}")
        return None, seed


def reset_pollinations_breaker():
    """Reset the breaker — called at the start of each pipeline run."""
    global _POLL_CONSECUTIVE_429, _POLL_OPEN_UNTIL
    _POLL_CONSECUTIVE_429 = 0
    _POLL_OPEN_UNTIL = 0.0


def _ready() -> "tuple[bool, str]":
    # No key check, deliberately - see the module docstring.
    if _pollinations_breaker_skip():
        wait = int(_POLL_OPEN_UNTIL - time.time())
        return False, f"breaker open after repeated failures ({max(0, wait)}s remaining)"
    return True, ""


def _generate(prompt, output_dir, trial, negative_prompt="", **_):
    return _pollinations_generate(prompt, output_dir, trial, negative_prompt=negative_prompt)


register(Provider(
    name="pollinations",
    kind="image",
    generate=_generate,
    ready=_ready,
    supports_reference=False,
    blurb="Free Flux via Pollinations. No key and no quota, so it is the "
          "fallback that still works when every keyed provider is spent.",
))
