"""Stable Horde — crowdsourced SDXL.

Self-contained: readiness, breaker state and the generate body all live
here. Adding or removing this provider is one file plus one import.

Works anonymously, so there is no credential gate.
STABLEHORDE_API_KEY is optional and only buys queue priority; its
absence makes generation slower, not impossible, so it must NOT be a
readiness condition. Treating an optional key as required would remove
a working provider from the chain.

The generate body keeps its own internal breaker (3 consecutive
failures -> 120s). That is deliberate and separate from the readiness
question: horde's characteristic failure is a job sitting in a
volunteer queue rather than erroring, so the breaker guards the
in-flight path while ready() stays permissive. A failure-counting gate
in ready() would not fire on the slow case, which is the case that
actually happens.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import time
import requests

from modules.providers.base import Provider, register
from modules.providers.prompt import _distill_prompt_for_flux

log = logging.getLogger(__name__)


# ── Stable Horde (community-run, genuinely free, SDXL) ────────
# Works anonymously (no signup, no card) — that's the whole point vs
# Together.ai which now gates every key behind a deposit. Anonymous
# uses a shared kudos queue (slower under load, ~30-60 sec typical);
# a free STABLEHORDE_API_KEY unlocks priority. Real Stable Diffusion
# XL weights — materially higher quality than Pollinations Flux.
#
# API: https://stablehorde.net/api/v2/
#   POST /generate/async  → returns { id }
#   GET  /generate/check/<id> → poll until { done: true }
#   GET  /generate/status/<id> → returns final { generations: [{ img: <b64> }] }
_HORDE_CONSEC_FAIL = 0
_HORDE_OPEN_UNTIL  = 0.0


def _horde_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via Stable Horde's SDXL crowdsourced endpoint.
    Returns (path, seed) on success, (None, seed) on failure/timeout.

    Uses the STABLEHORDE_API_KEY env var if set (priority in the queue),
    otherwise falls back to '0000000000' which the horde treats as
    anonymous — still works, just slower under load.
    """
    seed = int(hashlib.md5(f"{prompt}|{trial}|horde".encode()).hexdigest()[:8], 16)
    global _HORDE_CONSEC_FAIL, _HORDE_OPEN_UNTIL
    if time.time() < _HORDE_OPEN_UNTIL:
        return None, seed
    api_key = os.getenv("STABLEHORDE_API_KEY", "").strip() or "0000000000"
    # Distil to a Flux/SDXL-style tag prompt for best-quality output.
    final_prompt = _distill_prompt_for_flux(prompt)[:600]
    dest = os.path.join(output_dir, f"horde_{seed:08x}.jpg")
    try:
        # Submit async job.
        submit = requests.post(
            "https://stablehorde.net/api/v2/generate/async",
            headers={
                "apikey": api_key,
                "Client-Agent": "yt-agent:1.0:https://github.com/Ahsan3301/yt_agent",
                "Content-Type": "application/json",
            },
            json={
                "prompt":  final_prompt + (f" ### {negative_prompt}" if negative_prompt else ""),
                "params":  {
                    "sampler_name":     "k_euler",
                    "cfg_scale":        6.0,
                    "steps":            20,
                    "width":            576,
                    "height":           1024,
                    "seed":             str(seed),
                    "n":                1,
                },
                "models":  ["AlbedoBase XL (SDXL)", "Fustercluck", "Juggernaut XL"],
                "nsfw":    False,
                "trusted_workers": True,
                "r2":       True,
            },
            timeout=30,
        )
        if submit.status_code == 429:
            _HORDE_CONSEC_FAIL += 1
            if _HORDE_CONSEC_FAIL >= 3:
                _HORDE_OPEN_UNTIL = time.time() + 120
                log.warning("Stable Horde: 3x 429 -> circuit break 120 sec")
            return None, seed
        submit.raise_for_status()
        job_id = submit.json().get("id")
        if not job_id:
            log.warning(f"Stable Horde: no job id in response: {submit.text[:200]}")
            return None, seed
        # Poll until done (or 90 sec hard cap).
        # Previously 300 sec (5 min) — but Horde's queue is often congested
        # even with a priority API key. Waiting 5 min per stuck shot and
        # then falling through to Pollinations meant a 9-shot render
        # could take 45+ min. 90 sec is enough for a healthy queue
        # (typical priority-key completion is 15-40 sec); stuck jobs
        # fall through to Pollinations faster and the render moves on.
        deadline = time.time() + 90
        img_url = ""
        while time.time() < deadline:
            time.sleep(3)
            check = requests.get(
                f"https://stablehorde.net/api/v2/generate/check/{job_id}",
                timeout=15,
            )
            if not check.ok:
                continue
            js = check.json()
            if js.get("done"):
                break
            if js.get("faulted"):
                log.warning(f"Stable Horde: job faulted after {int(time.time()-(deadline-300))}s")
                return None, seed
        else:
            log.warning("Stable Horde: 5 min timeout, no result")
            return None, seed
        status = requests.get(
            f"https://stablehorde.net/api/v2/generate/status/{job_id}",
            timeout=30,
        )
        status.raise_for_status()
        gens = status.json().get("generations") or []
        if not gens:
            return None, seed
        # r2=True → generations[0].img is a URL. Otherwise it's base64.
        img_field = gens[0].get("img", "")
        if img_field.startswith("http"):
            img_url = img_field
            img_r = requests.get(img_url, timeout=30)
            img_r.raise_for_status()
            with open(dest, "wb") as f:
                f.write(img_r.content)
        else:
            import base64 as _b64
            with open(dest, "wb") as f:
                f.write(_b64.b64decode(img_field))
        if os.path.getsize(dest) < 4096:
            return None, seed
        _HORDE_CONSEC_FAIL = 0
        log.info(f"Stable Horde: image ok (seed {seed}, {os.path.getsize(dest)//1024} KB)")
        return dest, seed
    except Exception as e:
        _HORDE_CONSEC_FAIL += 1
        log.warning(f"Stable Horde gen failed: {e}")
        return None, seed

def _ready() -> "tuple[bool, str]":
    """Always available.

    Kept as an explicit function rather than ready=None so the reason
    for having no conditions is written next to the provider instead of
    looking like an oversight.
    """
    return True, ""


def _generate(prompt, output_dir, trial, negative_prompt="", **_):
    return _horde_generate(prompt, output_dir, trial, negative_prompt=negative_prompt)


register(Provider(
    name="horde",
    kind="image",
    generate=_generate,
    ready=_ready,
    supports_reference=False,
    # Static string on purpose. An earlier draft interpolated whether
    # STABLEHORDE_API_KEY was set - but blurbs are built at IMPORT time
    # and keys_sync populates the environment per JOB, so it would have
    # frozen whatever was true at worker boot and reported it forever.
    # That is the same import-time capture that disabled Agnes on every
    # render. Anything env-dependent belongs in ready().
    blurb="Real SDXL via the crowdsourced Stable Horde. Works anonymously; "
          "STABLEHORDE_API_KEY is optional and only buys queue priority.",
))
