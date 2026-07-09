"""
shotfinder.py — Storyboard-driven, vision-validated image selection.

The contract:
    fetch_shots(shots, output_dir, channel) -> list of source dicts

For each shot, this module tries every enabled provider, vision-judges each
candidate against the shot's `visual_description`, and picks the best
match. Failed shots are skipped (caller falls through gracefully).
"""
import os
import time
import logging
import base64
import hashlib
import urllib.parse

import requests

from modules import nim
from modules._net import retry
from modules.config import load_settings
from modules import footage as F   # reuse provider helpers + dedup state
from modules.image_prompter import craft_image_prompt

log = logging.getLogger(__name__)


# ── Per-provider preview searchers ────────────────────────────

def _ss_search_previews(query, count, exclude_ids):
    token, scope = F._shutterstock_token()
    if not token or scope != "user":
        return []
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "query": query, "per_page": min(max(count, 5), 100),
        "orientation": "vertical", "view": "full",
        "safe": "true" if F._restrictions_on() else "false",
        "image_type": "photo",
    }
    try:
        r = retry(lambda: requests.get(
            "https://api.shutterstock.com/v2/images/search",
            headers=headers, params=params, timeout=15,
        ), attempts=2, on=(requests.RequestException,), desc="ss-shot-search")
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Shutterstock shot search error for {query!r}: {e}")
        return []
    out = []
    for it in r.json().get("data", []):
        iid = it.get("id")
        if not iid or f"shutterstock:{iid}" in exclude_ids:
            continue
        u = F._shutterstock_preview_url(it)
        if u:
            out.append((iid, u, it))
    return out


def _ss_license_download(image_id, output_dir):
    token, _ = F._shutterstock_token()
    sub_id = F._shutterstock_subscription_id(token) if token else None
    if not token or not sub_id:
        return None
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        lr = retry(lambda: requests.post(
            "https://api.shutterstock.com/v2/images/licenses",
            headers=headers,
            json={
                "images": [{"image_id": str(image_id), "subscription_id": sub_id}],
                "format": "jpg", "size": "huge",
            },
            timeout=20,
        ), attempts=2, on=(requests.RequestException,), desc="ss-shot-license")
        lr.raise_for_status()
    except Exception as e:
        log.warning(f"Shutterstock license failed for {image_id}: {e}")
        return None
    data = (lr.json().get("data") or [{}])[0]
    if data.get("error"):
        log.warning(f"Shutterstock license error: {data.get('error')}")
        return None
    url = (data.get("download") or {}).get("url")
    if not url:
        return None
    dest = os.path.join(output_dir, f"shutterstock_{image_id}.jpg")
    return F.download_file(url, dest)


def _pexels_search_previews(query, count, exclude_ids):
    if not F.PEXELS_KEY:
        return []
    headers = {"Authorization": F.PEXELS_KEY}
    try:
        r = retry(lambda: requests.get(
            "https://api.pexels.com/v1/search",
            headers=headers,
            params={"query": query, "per_page": min(count, 80),
                    "orientation": "portrait", "size": "large"},
            timeout=20,
        ), attempts=2, on=(requests.RequestException,), desc="pexels-shot-search")
        r.raise_for_status()
    except Exception as e:
        log.warning(f"Pexels shot search error: {e}")
        return []
    out = []
    for p in r.json().get("photos", []):
        pid = p.get("id")
        if not pid or f"pexels_img:{pid}" in exclude_ids:
            continue
        src = p.get("src") or {}
        preview = src.get("medium") or src.get("large") or src.get("portrait")
        full = src.get("large2x") or src.get("original") or src.get("large")
        if preview and full:
            out.append((pid, preview, full))
    return out


def _pexels_download_full(image_id, full_url, output_dir):
    dest = os.path.join(output_dir, f"pexels_img_{image_id}.jpg")
    return F.download_file(full_url, dest)


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


# Flux prompt distiller — condenses long visual_description prose into
# a 15-25 word tag-style prompt. Flux only weights the first ~77 tokens
# meaningfully; sending a 500-char poetic description caused Flux to
# truncate and hallucinate a generic image. Distilled output is
# comma-separated subject + key details + style tags, which is what
# every stable-diffusion / Flux fine-tune expects.
_FLUX_DISTILL_CACHE: dict[str, str] = {}


# One-shot session flag — after the first NIM distiller timeout we
# stop calling NIM entirely and use the regex-based shortener for the
# rest of the render. Was previously burning ~30 sec per shot on NIM
# timeouts, one per shot × 8 shots = 4 minutes wasted per video.
_FLUX_DISTILLER_NIM_BROKEN = False


def _regex_distill(text: str) -> str:
    """Deterministic prompt shortener — no LLM. Strips filler, keeps
    concrete nouns, comma-splits into tag style, hard-caps at 200 chars.
    Not as elegant as an LLM rewrite but fast (< 1 ms) and never
    times out. Used as fallback when NIM is slow, AND for every
    subsequent shot after the first NIM failure."""
    import re
    t = (text or "").strip()
    # Kill filler phrases the LLM loves that add nothing for Flux.
    for junk in [
        "wide establishing shot of", "wide shot of", "low-angle shot of",
        "close-up of", "extreme close-up of", "overhead shot of",
        "wide angle view of", "camera focuses on", "we see",
        "the frame captures", "in the foreground", "in the background",
        "the composition", "the shot", "the scene", "the image",
        "cinematic depth of field", "with a shallow depth of field",
    ]:
        t = re.sub(re.escape(junk), "", t, flags=re.IGNORECASE)
    # Collapse whitespace + break long sentences into comma tags.
    t = re.sub(r"[;.]\s*", ", ", t)
    t = re.sub(r"\s+", " ", t).strip(" ,.")
    # Hard cap 200 chars for Flux's 77-token limit + append style tags.
    t = t[:200].rstrip(" ,.")
    if not t.lower().endswith(("photorealistic", "cinematic", "sharp focus")):
        t += ", photorealistic, cinematic, sharp focus"
    return t


def _distill_prompt_for_flux(visual_description: str, channel: str = "") -> str:
    """Return a Flux-optimised tag-style prompt.

    Uses ONLY the deterministic regex distiller. NIM was previously used
    for a per-shot LLM rewrite, but the free tier's 40 rpm limit + our
    10 sec timeout meant every render burned quota on retries AND still
    fell back to regex. Skipping NIM entirely: same net output for
    slow-NIM renders (99% of them), zero rate-limit burn, no wasted
    wall-clock. The user can enable LLM distillation via the
    NIM_DISTILLER=1 env var if their NIM tier is genuinely fast.
    """
    key = (visual_description or "").strip()
    if not key:
        return ""
    if key in _FLUX_DISTILL_CACHE:
        return _FLUX_DISTILL_CACHE[key]
    if os.getenv("NIM_DISTILLER", "").strip() not in ("1", "true", "yes"):
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out
    # Opt-in NIM path (user set NIM_DISTILLER=1). Same guard as before —
    # first NIM failure of the session flips the session-wide broken
    # flag so subsequent shots go straight to regex.
    global _FLUX_DISTILLER_NIM_BROKEN
    if _FLUX_DISTILLER_NIM_BROKEN:
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out
    try:
        prompt = (
            "Rewrite the scene below into a short image-generation prompt "
            "for Flux / SDXL. Format: 15 to 25 words, comma-separated. "
            "Structure: MAIN SUBJECT, key visual details, environment, "
            "lighting/mood, style tags. No poetic prose, no complete "
            "sentences, no 'shot' / 'scene' / 'image' words. "
            f"Channel: {channel or 'generic'}.\n\nSCENE: {key[:400]}\n\n"
            "Reply with ONLY the prompt string."
        )
        raw = nim.chat(
            messages=[{"role": "user", "content": prompt}],
            model="meta/llama-3.3-70b-instruct",
            max_tokens=80,
            temperature=0.5,
            stream=False,
            timeout=10,
            attempts=1,
        )
        distilled = (raw or "").strip().strip('"').strip().split("\n")[0]
        for pfx in ("Prompt:", "prompt:", "PROMPT:", "-"):
            if distilled.lower().startswith(pfx.lower()):
                distilled = distilled[len(pfx):].strip()
        distilled = distilled[:240]
        if len(distilled) < 15:
            distilled = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = distilled
        return distilled
    except Exception as e:
        _FLUX_DISTILLER_NIM_BROKEN = True
        log.warning(f"flux distiller (NIM opt-in): failed ({e}); regex from now on")
        out = _regex_distill(key)
        _FLUX_DISTILL_CACHE[key] = out
        return out


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


# ── HuggingFace Inference API (free fallback when Pollinations is rate-limited) ─
# Same breaker pattern as Pollinations. HF returns image bytes directly.
# Default model is SDXL base 1.0 — fast and gives decent horror/cinematic.
_HF_CONSECUTIVE_FAILS = 0
_HF_OPEN_UNTIL = 0.0
_HF_BACKOFF_THRESHOLD = 3
_HF_OPEN_FOR_SECONDS = 120

_HF_MODEL = os.getenv("HF_IMAGE_MODEL",
                     "stabilityai/stable-diffusion-xl-base-1.0")


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
    url = f"https://api-inference.huggingface.co/models/{_HF_MODEL}"
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


# ── Local SDXL (via diffusers) — free GPU-only fallback ──────────
#
# Runs on the worker's own CUDA device (T4/P100 on Colab/Kaggle).
# Model is cached on first use; subsequent generations are ~5-8 sec.
# No rate limits, no API keys, and native negative_prompt support.
# On a CPU-only worker this provider silently no-ops.

# Device-keyed pipeline cache. Empty on CPU; single entry {0: pipe} on
# T4x1; two entries {0: pipe0, 1: pipe1} when running on T4x2 with
# multi-GPU mode enabled. Each pipe is bound to its own CUDA device so
# round-robin dispatch from _fetch_one can drive both cards concurrently.
_LOCAL_SDXL_PIPES: dict = {}
_LOCAL_SDXL_BROKEN = False
_LOCAL_SDXL_BROKEN_REASON = ""
# Per-device "this specific card can't load" markers. Used when GPU 0
# works but GPU 1 OOMs during load — we want to keep serving from GPU 0
# and just skip GPU 1 in round-robin, not tank the whole provider.
_LOCAL_SDXL_DEVICE_BROKEN: dict = {}
# Serialises the one-shot model load PER DEVICE. Two devices load in
# parallel because they hold different locks. Within a device, the
# standard double-checked pattern keeps the fast path lock-free.
import threading as _sdxl_threading
_LOCAL_SDXL_LOAD_LOCKS: dict = {}
_LOCAL_SDXL_LOCKS_LOCK = _sdxl_threading.Lock()
# Thread-local so shotfetch workers can each pin themselves to a GPU
# without threading a device_id through the whole provider-callable
# signature (huggingface/pollinations/horde are HTTP and ignore it).
_LOCAL_SDXL_TLS = _sdxl_threading.local()


def _sdxl_lock_for(device_id: int):
    with _LOCAL_SDXL_LOCKS_LOCK:
        lk = _LOCAL_SDXL_LOAD_LOCKS.get(device_id)
        if lk is None:
            lk = _sdxl_threading.Lock()
            _LOCAL_SDXL_LOAD_LOCKS[device_id] = lk
        return lk


def _current_sdxl_device() -> int:
    """Which cuda:N should this thread's local_sdxl call target?

    _fetch_one sets `_LOCAL_SDXL_TLS.device` per-shot in round-robin
    order (0,1,0,1,...) when multi-GPU is on. Anything outside that
    threadpool (e.g. pre-warm on the main thread) passes an explicit
    device_id, so this default only fires on unexpected callers → 0.
    """
    return int(getattr(_LOCAL_SDXL_TLS, "device", 0))


def _local_sdxl_load(device_id: int | None = None):
    """Lazy-load the diffusers pipeline on a specific CUDA device (thread-safe).

    Kept out of module import path so CPU workers never pay the
    diffusers/torch import tax. All failure paths WARN with actionable
    text so the priority loop's provider skip is diagnosable from logs.
    """
    if _LOCAL_SDXL_BROKEN:
        return None
    if device_id is None:
        device_id = _current_sdxl_device()
    if _LOCAL_SDXL_DEVICE_BROKEN.get(device_id):
        return None
    # Fast path — no lock needed once THIS device's pipeline exists.
    pipe = _LOCAL_SDXL_PIPES.get(device_id)
    if pipe is not None:
        return pipe
    # Slow path — grab the device's lock and re-check inside so exactly
    # ONE thread performs the download + CUDA move per device.
    with _sdxl_lock_for(device_id):
        if _LOCAL_SDXL_BROKEN:
            return None
        if _LOCAL_SDXL_DEVICE_BROKEN.get(device_id):
            return None
        pipe = _LOCAL_SDXL_PIPES.get(device_id)
        if pipe is not None:
            return pipe
        return _local_sdxl_load_locked(device_id)


def _local_sdxl_load_locked(device_id: int):
    """Actual load path. Caller must hold the per-device load lock."""
    global _LOCAL_SDXL_BROKEN, _LOCAL_SDXL_BROKEN_REASON
    # Import torch first — every other failure depends on it.
    try:
        import torch
    except ImportError as e:
        _LOCAL_SDXL_BROKEN = True
        _LOCAL_SDXL_BROKEN_REASON = f"torch not installed: {e}"
        log.warning(
            "local_sdxl: torch is not installed on this worker — provider "
            "DISABLED. Reinstall requirements-gpu.txt or run cell 3 of the "
            "Colab notebook."
        )
        return None
    if not torch.cuda.is_available():
        _LOCAL_SDXL_BROKEN = True
        _LOCAL_SDXL_BROKEN_REASON = "no CUDA device"
        log.warning(
            "local_sdxl: torch.cuda.is_available() is False — no GPU on this "
            "runtime. Provider DISABLED for this process. "
            "(This is normal for the Oracle side-worker + HF CPU Space.)"
        )
        return None
    # Preflight: modern PyTorch wheels dropped sm_5x + sm_6x kernels,
    # so a P100 (sm_6.0) or older Pascal will `.to("cuda")` and throw
    # cudaErrorNoKernelImageForDevice on the first tensor op. Skip
    # early so we don't waste time downloading a 7 GB SDXL model just
    # to fail on `.to("cuda")` at the end.
    try:
        _cap = torch.cuda.get_device_capability(device_id)
        if _cap[0] < 7:
            # This device can't run SDXL, but a SIBLING device might —
            # mark just this device broken so the other GPU keeps
            # serving. If it's the only device visible, the round-robin
            # dispatcher will fall through to the next AI provider on
            # its own once every device is broken.
            _LOCAL_SDXL_DEVICE_BROKEN[device_id] = (
                f"cuda:{device_id} sm_{_cap[0]}.{_cap[1]} < sm_7.0"
            )
            log.info(
                f"local_sdxl[cuda:{device_id}] skipped: "
                f"{_LOCAL_SDXL_DEVICE_BROKEN[device_id]}"
            )
            return None
    except Exception:
        pass   # fall through if the probe itself fails
    try:
        from diffusers import AutoPipelineForText2Image
    except ImportError as e:
        _LOCAL_SDXL_BROKEN = True
        _LOCAL_SDXL_BROKEN_REASON = f"diffusers not installed: {e}"
        log.warning(
            "local_sdxl: diffusers is not installed on this worker — provider "
            "DISABLED. On Colab: re-run cell 3 (it now installs diffusers "
            "transformers accelerate). On Kaggle: `pip install diffusers>=0.30 "
            "transformers>=4.40 accelerate>=0.30`."
        )
        return None
    model_id = os.getenv(
        "LOCAL_SDXL_MODEL",
        (load_settings().get("image_gen", {}) or {}).get(
            "local_sdxl_model", "stabilityai/sdxl-turbo"
        ),
    )
    # First-load model download is ~7 GB for sdxl-turbo. The user needs to
    # see this happening so they don't think the render is stuck. Log to
    # WARN so it lands on the dashboard's realtime log stream.
    log.warning(
        f"local_sdxl: loading pipeline model={model_id!r} — first-load "
        f"download can be 2-5 min on a fresh Colab/Kaggle runtime "
        f"(cached for the rest of the session)."
    )
    # Hard timeout on the download so a genuinely stuck fetch (HF outage,
    # network drop) bails the provider instead of blocking every shot.
    # Falls through to the next provider in the priority loop. 6 min is
    # generous — a healthy fetch finishes in 60-120 sec.
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "360")
    try:
        # bfloat16 gives quality parity with fp16 on Ampere+/Hopper and
        # avoids some VAE overflow artifacts. On Turing (T4, sm_7.5) and
        # older, bf16 is only available via slow software emulation. But
        # newer PyTorch's is_bf16_supported() counts emulation as
        # supported → returns True on T4 → pipeline runs on emulated bf16
        # which is slow AND less numerically stable than native fp16
        # (contributed to the SDXL scheduler off-by-one indexing bug we
        # were hitting on T4). Gate on compute capability instead:
        # sm_8.0 = Ampere, first arch with hardware bf16.
        cap = torch.cuda.get_device_capability(device_id)
        use_bf16 = cap[0] >= 8
        dtype = torch.bfloat16 if use_bf16 else torch.float16
        # The `variant="fp16"` load path only exists for models that
        # actually publish an fp16-suffixed weights file. sdxl-turbo does;
        # some community forks do not. Fall back to variant=None on a
        # load failure so a swapped-in model still boots.
        # low_cpu_mem_usage=False loads the whole state_dict in one shot
        # instead of materializing each of ~517 layer params one at a time
        # (diffusers default). Skips a ~8 min per-layer loop on SDXL first
        # load — the biggest single win when local_sdxl is primary. Costs
        # ~3× peak CPU RAM during load; Kaggle T4×2 has 31 GB free so
        # we're well under.
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id,
                torch_dtype=dtype,
                variant="fp16" if not use_bf16 else None,
                use_safetensors=True,
                low_cpu_mem_usage=False,
            )
        except Exception as e_variant:
            log.warning(
                f"local_sdxl: variant='fp16' load failed ({e_variant}); "
                f"retrying without variant hint …"
            )
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id, torch_dtype=dtype, use_safetensors=True,
                low_cpu_mem_usage=False,
            )
        pipe = pipe.to(f"cuda:{device_id}")
        # Memory-thrift knobs — matters on T4-16GB.
        try:
            pipe.enable_vae_slicing()
            pipe.enable_attention_slicing()
        except Exception:
            pass
        _LOCAL_SDXL_PIPES[device_id] = pipe
        log.warning(
            f"local_sdxl[cuda:{device_id}]: pipeline READY "
            f"(dtype={dtype}, model={model_id})"
        )
        return pipe
    except Exception as e:
        # Per-device failure: mark THIS device broken (not the whole
        # provider) so a sibling GPU can keep serving. Only when every
        # device is broken does the provider actually stop responding.
        _LOCAL_SDXL_DEVICE_BROKEN[device_id] = f"{type(e).__name__}: {e}"
        log.warning(
            f"local_sdxl[cuda:{device_id}]: pipeline load FAILED "
            f"({type(e).__name__}: {e}). Common causes: OOM (VRAM), "
            f"corrupted HF cache, model id typo. Sibling GPUs (if any) "
            f"keep serving; if none, priority loop skips to next provider."
        )
        return None


def _local_sdxl_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image on the local GPU. Returns (path, seed) on
    success, (None, seed) on failure or when disabled.

    Device selection: thread-local, set by _fetch_one round-robin. On
    T4x1 always cuda:0; on T4x2 alternates cuda:0/cuda:1 per shot.
    """
    seed = int(hashlib.md5(f"{prompt}|{trial}|sdxl".encode()).hexdigest()[:8], 16)
    device_id = _current_sdxl_device()
    pipe = _local_sdxl_load(device_id)
    if pipe is None:
        return None, seed
    try:
        import torch
        gen = torch.Generator(device=f"cuda:{device_id}").manual_seed(seed)
        # SDXL-Turbo is calibrated for very few steps + guidance 0. If the
        # user swapped to a full SDXL model, guidance 5-7 + 25 steps is a
        # good default; we detect via the pipe class name.
        # pipe.name_or_path may be None on some diffusers versions; coerce
        # to str before .lower() so we don't crash the whole provider.
        pipe_name = str(getattr(pipe, "name_or_path", "") or "").lower()
        env_model = str(os.getenv("LOCAL_SDXL_MODEL", "") or "").lower()
        settings_model = str(
            (load_settings().get("image_gen", {}) or {}).get("local_sdxl_model", "")
        ).lower()
        is_turbo = "turbo" in pipe_name or "turbo" in env_model or "turbo" in settings_model
        kwargs = {
            "prompt": prompt,
            "negative_prompt": negative_prompt or None,
            "height": 1024,
            "width": 576,   # 9:16 portrait; SDXL handles this via 32-multiple sizes
            "generator": gen,
        }
        if is_turbo:
            # 5 (not 4) — SDXL-turbo's default EulerDiscreteScheduler
            # creates a sigmas array of length num_inference_steps+1. At
            # steps=4 the array is length 5; one code path inside
            # diffusers' turbo prompt-encoder branch tries to access
            # sigmas[num_inference_steps]=sigmas[5] and blows up with
            # "index 5 is out of bounds for dimension 0 with size 5" on
            # ~half the generation attempts. Bumping to 5 makes the
            # array length 6 → index 5 is valid → the bug can't fire.
            # +25% inference time (~0.5-1 sec / image on T4) is trivial
            # vs losing an entire retry to the crash.
            kwargs.update({"num_inference_steps": 5, "guidance_scale": 0.0})
        else:
            kwargs.update({"num_inference_steps": 25, "guidance_scale": 6.5})
        image = pipe(**kwargs).images[0]
        dest = os.path.join(output_dir, f"local_sdxl_{seed:08x}.jpg")
        image.save(dest, quality=92)
        if not os.path.exists(dest) or os.path.getsize(dest) < 4096:
            log.warning("local_sdxl: pipe returned <4 KB — treating as failure")
            return None, seed
        return dest, seed
    except Exception as e:
        msg = str(e)
        # Terminal errors: CUDA capability mismatch means the torch
        # wheel doesn't have kernels for this GPU. OOM means this
        # device can't run the model. Both are permanent for the
        # affected device — mark THAT device broken so we don't waste
        # 5 attempts on the same failure, but let sibling GPUs keep
        # serving (T4x2). The _provider_ready check demotes the
        # provider only after every device is broken.
        terminal_markers = (
            "no kernel image is available",
            "cudaErrorNoKernelImageForDevice",
            "CUDA out of memory",
            "CUDA driver version is insufficient",
        )
        if any(m in msg for m in terminal_markers):
            _LOCAL_SDXL_DEVICE_BROKEN[device_id] = msg[:200]
            log.warning(
                f"local_sdxl[cuda:{device_id}]: TERMINAL error, this GPU "
                f"DISABLED — {msg[:200]}. Sibling GPUs (if any) keep "
                f"serving; provider skips once every device is broken."
            )
        else:
            log.warning(f"local_sdxl[cuda:{device_id}] gen failed: {e}")
        return None, seed


def _score_local_image(path, visual, premise):
    """Vision-score a LOCAL image file by passing it as a data URL."""
    try:
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return nim.vision_score(
            f"data:image/jpeg;base64,{b64}",
            fit_description=visual, premise=premise,
        )
    except Exception as e:
        log.warning(f"score_local_image error: {e}")
        return -1


# ── Per-shot finder ──────────────────────────────────────────

def find_image_for_shot(shot, output_dir, used_ids, channel="horror"):
    # Cancel check at entry — a user clicking Cancel between shots
    # shouldn't have to wait for the current shot to fully resolve
    # before the pipeline unwinds.
    from modules import run_state as _rs
    _rs.check_cancel()

    vid_cfg = load_settings().get("video", {})
    providers = load_settings().get("providers", {}) or {}
    threshold = int(vid_cfg.get("vision_judge_threshold", 4))
    judge_on = bool(vid_cfg.get("vision_judge_enabled", True)) and nim.is_available()

    visual = shot.get("visual_description") or shot.get("search_query") or ""
    query = shot.get("search_query") or ""
    ai_prompt = shot.get("ai_prompt") or visual
    premise = shot.get("narration_excerpt") or ""

    # Very defensive clamp — only if the query is absurdly long. The
    # LLM's own query is left alone otherwise; the earlier 6-word cap
    # was truncating good 7-8 word queries and hurting match quality.
    # If stock returns nothing on the original, the generic fallback
    # below still fires as a safety net.
    def _shorten(q: str, max_words: int) -> str:
        words = [w for w in q.split() if w]
        return " ".join(words[:max_words])
    if query and len(query.split()) > 12:
        log.info(f"Shot fetch: query >12 words, clamping to 10")
        query = _shorten(query, 10)

    # Generic backup query built from visual_description keywords. Used
    # by providers that return zero candidates for the specific query.
    _stop = {"the","a","an","and","or","of","for","with","from","in","on",
             "at","to","by","is","are","was","were","be","been","that",
             "this","which","who","what","how","its","it","as","into"}
    _visual_words = [
        w.strip(".,;:'\"()") for w in (visual or "").lower().split()
        if w.strip(".,;:'\"()") and w.lower().strip(".,;:'\"()") not in _stop
        and not w[0].isdigit()
    ]
    query_generic = " ".join(_visual_words[:3]) if _visual_words else query

    log.info(f"Shot fetch | query={query!r} | generic_fallback={query_generic!r} | excerpt={premise[:60]!r}")

    best = None  # (score, source_dict_or_lazy)

    def consider(score, src_or_lazy):
        nonlocal best
        if best is None or score > best[0]:
            best = (score, src_or_lazy)

    # ── 1. Shutterstock ──
    if providers.get("shutterstock", True) and query:
        previews = _ss_search_previews(query, count=8, exclude_ids=used_ids)
        if previews and judge_on:
            scored = []
            for iid, url, _ in previews[:6]:
                s = nim.vision_score(url, fit_description=visual, premise=premise)
                if s >= 0:
                    scored.append((s, iid))
            scored.sort(reverse=True, key=lambda x: x[0])
            if scored:
                top_s, top_id = scored[0]
                log.info(f"  Shutterstock top: {top_s}/10 (id {top_id})")
                if top_s >= threshold:
                    path = _ss_license_download(top_id, output_dir)
                    if path:
                        used_ids.add(f"shutterstock:{top_id}")
                        F._remember_clip(f"shutterstock:{top_id}")
                        return {"type": "image", "path": path,
                                "origin": "shutterstock", "score": top_s}
                else:
                    consider(top_s, ("shutterstock-lazy", top_id))
        elif previews:
            iid = previews[0][0]
            path = _ss_license_download(iid, output_dir)
            if path:
                used_ids.add(f"shutterstock:{iid}")
                F._remember_clip(f"shutterstock:{iid}")
                return {"type": "image", "path": path,
                        "origin": "shutterstock", "score": -1}

    # ── 2. Pexels ──
    if providers.get("pexels", True) and query:
        previews = _pexels_search_previews(query, count=8, exclude_ids=used_ids)
        if previews and judge_on:
            scored = []
            for pid, preview, full in previews[:6]:
                s = nim.vision_score(preview, fit_description=visual, premise=premise)
                if s >= 0:
                    scored.append((s, pid, full))
            scored.sort(reverse=True, key=lambda x: x[0])
            if scored:
                top_s, top_id, full = scored[0]
                log.info(f"  Pexels top: {top_s}/10 (id {top_id})")
                if top_s >= threshold:
                    path = _pexels_download_full(top_id, full, output_dir)
                    if path:
                        used_ids.add(f"pexels_img:{top_id}")
                        F._remember_clip(f"pexels_img:{top_id}")
                        return {"type": "image", "path": path,
                                "origin": "pexels_img", "score": top_s}
                else:
                    consider(top_s, ("pexels-lazy", top_id, full))
        elif previews:
            pid, _, full = previews[0]
            path = _pexels_download_full(pid, full, output_dir)
            if path:
                used_ids.add(f"pexels_img:{pid}")
                F._remember_clip(f"pexels_img:{pid}")
                return {"type": "image", "path": path,
                        "origin": "pexels_img", "score": -1}

    # ── 3. AI image generation — priority-ordered, settings-driven ──
    # The user configures priority + toggles in settings.image_gen.
    # We walk providers in the declared order; each provider gets its
    # own ai_image_attempts_per_shot budget and returns on first
    # threshold-passing image. A disabled or key-less provider is
    # skipped with a log line so it's obvious in the output.
    ai_attempts = int(vid_cfg.get("ai_image_attempts_per_shot", 3))
    # If stock (Shutterstock + Pexels) returned literally nothing, this
    # shot has no fallback to below-threshold stock — every failed AI
    # attempt is a dropped shot. Bump the AI budget to 5 in that case
    # + drop the vision-judge threshold to 1 so an on-topic AI image
    # isn't rejected for being "not amazing enough". This turns 'niche
    # science shots' from '0-1 clips out of 15' into 'most shots
    # filled with an on-topic Flux/HF image'.
    stock_yielded_nothing = best is None
    if stock_yielded_nothing:
        ai_attempts = max(ai_attempts, 5)
        # Save the original then relax the local judge threshold. We
        # do this AFTER the stock branches so it doesn't affect them.
        threshold = min(threshold, 1)
        log.info(
            f"  stock returned no candidates; boosting AI budget to "
            f"{ai_attempts} attempts + relaxing vision threshold to "
            f"{threshold} so shots don't drop"
        )
    ig_cfg = (load_settings().get("image_gen") or {})
    priority = ig_cfg.get("priority") or ["huggingface", "local_sdxl", "pollinations"]
    ig_enabled = ig_cfg.get("enabled") or {}
    negative_prompt = str(ig_cfg.get("negative_prompt") or "").strip()

    def _provider_ready(name: str) -> tuple[bool, str]:
        """Return (ready, reason-if-not). Combines user toggle + key/GPU check."""
        # Master enable in settings.image_gen.enabled AND the legacy
        # providers.<name> toggle both count as "off". Either off → skip.
        if ig_enabled.get(name, True) is False:
            return False, "disabled in settings"
        if providers.get(name, True) is False:
            return False, "disabled in providers toggle"
        if name == "huggingface":
            if not os.getenv("HF_TOKEN", "").strip():
                return False, "no HF_TOKEN"
        if name == "local_sdxl":
            if _LOCAL_SDXL_BROKEN:
                return False, f"local pipeline broken ({_LOCAL_SDXL_BROKEN_REASON})"
            # If every visible device has been marked broken, the
            # provider has nothing left to serve — skip to the next AI
            # provider instead of racking up per-shot failures.
            try:
                from modules import gpu_topology as _gt
                if _gt.sdxl_ready_devices and all(
                    d in _LOCAL_SDXL_DEVICE_BROKEN for d in _gt.sdxl_ready_devices
                ):
                    return False, "every GPU marked broken during load/gen"
            except Exception:
                pass
        # 'horde' + 'together' have no required key (horde works anon).
        return True, ""

    _AI_PROVIDERS = {
        "horde":       _horde_generate,        # real SDXL crowdsourced, works anon
        "huggingface": _huggingface_generate,
        "local_sdxl":  _local_sdxl_generate,
        "pollinations": _pollinations_generate,
    }

    for slot, provider_name in enumerate(priority):
        fn = _AI_PROVIDERS.get(provider_name)
        if fn is None:
            log.info(f"  [ai-{slot+1}] unknown provider {provider_name!r} — skipping")
            continue
        ready, reason = _provider_ready(provider_name)
        if not ready:
            log.info(f"  [ai-{slot+1}] {provider_name}: skipped ({reason})")
            continue
        log.info(f"  [ai-{slot+1}] {provider_name}: trying ({ai_attempts} attempts)")
        for trial in range(ai_attempts):
            _rs.check_cancel()
            crafted = craft_image_prompt(
                narration_excerpt=premise,
                visual_description=visual,
                channel=channel,
                # Offset per provider so each gets a distinct seed pool.
                attempt=trial + (slot * 100),
            )
            prompt_to_use = crafted or ai_prompt
            log.info(f"    {provider_name} prompt (try {trial+1}): {(crafted or ai_prompt)[:90]}...")
            path, seed = fn(prompt_to_use, output_dir, trial, negative_prompt)
            if not path:
                continue
            tag = f"{provider_name}:{seed}"
            if judge_on:
                s = _score_local_image(path, visual, premise)
                log.info(f"    {provider_name}: {s}/10 (seed {seed})")
                if s >= threshold:
                    used_ids.add(tag)
                    F._remember_clip(tag)
                    return {"type": "image", "path": path,
                            "origin": provider_name, "score": s}
                if s > 0:
                    consider(s, {"type": "image", "path": path,
                                 "origin": provider_name, "score": s})
            else:
                used_ids.add(tag)
                F._remember_clip(tag)
                return {"type": "image", "path": path,
                        "origin": provider_name, "score": -1}

    # ── 4. Last-resort: license the best below-threshold candidate ──
    if best is not None:
        score, payload = best
        if isinstance(payload, tuple):
            kind = payload[0]
            if kind == "shutterstock-lazy":
                _, top_id = payload
                path = _ss_license_download(top_id, output_dir)
                if path:
                    log.info(f"  Fallback Shutterstock id {top_id} (below threshold, score {score}/10)")
                    used_ids.add(f"shutterstock:{top_id}")
                    F._remember_clip(f"shutterstock:{top_id}")
                    return {"type": "image", "path": path,
                            "origin": "shutterstock", "score": score}
            elif kind == "pexels-lazy":
                _, top_id, full = payload
                path = _pexels_download_full(top_id, full, output_dir)
                if path:
                    log.info(f"  Fallback Pexels id {top_id} (below threshold, score {score}/10)")
                    used_ids.add(f"pexels_img:{top_id}")
                    F._remember_clip(f"pexels_img:{top_id}")
                    return {"type": "image", "path": path,
                            "origin": "pexels_img", "score": score}
        else:
            return payload  # already-completed Pollinations dict

    # LAST-DITCH: try again with a channel-generic query drawn from the
    # channel's own footage_keywords in CHANNEL_PRESETS. This kicks in
    # when every previous branch produced nothing — usually because the
    # LLM's search_query was too niche for stock providers AND the AI
    # providers all rate-limited or errored on this shot. Better to fill
    # the shot with an on-genre stock image than drop the shot entirely
    # (dropped shots are what turned a 10-shot storyboard into 1-2 clips).
    try:
        from modules import channels as _ch
        preset = _ch.CHANNEL_PRESETS.get(channel) or {}
        keywords = preset.get("footage_keywords") or []
    except Exception:
        keywords = []
    # Also add the shortened visual-description generic as an option.
    fallback_queries = []
    if query_generic and query_generic != query:
        fallback_queries.append(query_generic)
    fallback_queries.extend(keywords[:5])
    for fq in fallback_queries:
        log.info(f"  last-ditch fallback with generic query {fq!r}")
        if providers.get("pexels", True):
            previews = _pexels_search_previews(fq, count=4, exclude_ids=used_ids)
            if previews:
                pid, _, full = previews[0]
                path = _pexels_download_full(pid, full, output_dir)
                if path:
                    used_ids.add(f"pexels_img:{pid}")
                    F._remember_clip(f"pexels_img:{pid}")
                    log.info(f"  fallback filled shot with pexels id {pid} (query={fq!r})")
                    return {"type": "image", "path": path,
                            "origin": "pexels_img_fallback", "score": -1}
    log.warning(f"  No image found for shot {query!r} even after generic fallback")
    return None


def fetch_shots(shots, output_dir, channel="horror", preset_sources=None):
    """For each shot, fetch one image (with vision validation). Returns the
    list of source dicts in shot order. Missing shots are simply skipped.

    `preset_sources`: when the user provided their own images via manual
    mode, drop them into the EARLIEST shots first (one per shot) and
    only call the provider chain for the remaining shots. Lets the user
    seed the story visually without throwing away the auto-fetcher.

    Reports per-shot progress to run_state so the dashboard bar moves
    smoothly during this long step (the footage stage owns 30%..60% of
    the bar). Checks for user cancellation between shots."""
    from pathlib import Path
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading as _threading
    from modules import run_state
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    reset_pollinations_breaker()
    reset_hf_breaker()
    used_ids = set(F._load_used_clips())
    presets = list(preset_sources or [])
    total = max(1, len(shots))

    # Parallelism: a single SDXL inference at 1024x576 uses ~4-5 GB
    # VRAM, so 3 concurrent shots fits comfortably on a 16 GB T4
    # (~12-15 GB peak). HF Inference API + Pollinations are HTTP calls
    # with no per-worker cost, so parallelism is a free speedup for
    # them too. Setting exposed under settings.image_gen.shot_parallelism
    # — default 3. On T4x2 (multi-GPU) the ceiling doubles to 12: each
    # card holds its own 3-shot batch and the round-robin dispatcher
    # below balances load across GPU 0 / GPU 1.
    ig_cfg = (load_settings().get("image_gen") or {})
    try:
        from modules import gpu_topology as _gt
        _sdxl_ceiling = 12 if _gt.supports_multi_gpu else 6
    except Exception:
        _sdxl_ceiling = 6
    max_workers = max(1, min(_sdxl_ceiling, int(ig_cfg.get("shot_parallelism", 3))))

    # used_ids is shared across threads; guard mutations with a lock so
    # two shots don't both burn the same pexels/shutterstock id and end
    # up with duplicated stock imagery.
    used_lock = _threading.Lock()

    # Round-robin GPU assignment: shot idx N lands on device_ids[N %
    # len]. Sticky per-shot so retries stay on the same GPU (keeps the
    # HF cache hot for that seed's prompt encoding). No-op on T4x1 —
    # every shot goes to cuda:0.
    try:
        from modules import gpu_topology as _gt
        _sdxl_devices = _gt.sdxl_ready_devices or [0]
    except Exception:
        _sdxl_devices = [0]

    def _fetch_one(idx: int, shot: dict, preset_src: dict | None):
        # Pin this worker thread to a specific CUDA device for any
        # local_sdxl call it makes. Read inside _local_sdxl_load /
        # _local_sdxl_generate via _current_sdxl_device().
        _LOCAL_SDXL_TLS.device = _sdxl_devices[idx % len(_sdxl_devices)]
        run_state.check_cancel()
        if preset_src is not None:
            src = dict(preset_src)
            log.info(f"Shot {idx+1}/{total}: preset image {src.get('path')}")
        else:
            log.info(f"Shot {idx+1}/{total}: fetching (cuda:{_LOCAL_SDXL_TLS.device})")
            # Snapshot used_ids under lock so the provider sees a
            # consistent view; merge new additions back under lock.
            with used_lock:
                snap = set(used_ids)
            src = find_image_for_shot(shot, output_dir, snap, channel=channel)
            with used_lock:
                used_ids.update(snap)
        if src:
            src["start"] = float(shot.get("start", 0.0))
            src["end"]   = float(shot.get("end", 0.0))
        return idx, src

    # If ANY preset is provided, respect the "earliest shots first" rule
    # by handing each preset to the corresponding shot index. Remaining
    # shots get None → falls through to the provider chain.
    preset_by_idx = {i: presets[i] for i in range(min(len(presets), len(shots)))}

    # Pre-warm local_sdxl on the main thread if it's enabled + first in
    # the priority list. Without this, thread 1 in the pool triggers a
    # 60-120 sec model download; thread 2+3 grab the load lock and wait
    # idle for that long, wasting their attempt budget. Warming here
    # means all N threads start with the pipeline ready and can gen
    # concurrently from the first attempt. No-op on CPU-only workers.
    try:
        _priority_head = (
            (load_settings().get("image_gen") or {}).get("priority")
            or ["huggingface", "local_sdxl", "pollinations"]
        )
        _ig_enabled = (load_settings().get("image_gen") or {}).get("enabled") or {}
        # Only pre-warm if the user has EXPLICITLY opted in — default is
        # off now that HF Inference API + Pollinations handle image gen
        # reliably. Old code defaulted the toggle to True which meant a
        # 2-hour model-download stall on any Kaggle session where torch
        # got clobbered by a dep upgrade.
        if "local_sdxl" in _priority_head and _ig_enabled.get("local_sdxl", False):
            # On T4x2 (multi-GPU), warm BOTH pipelines in parallel so
            # the shot pool starts with the second card already ready
            # instead of paying a serial ~1 min second-load on the
            # first shot that lands on cuda:1.
            try:
                from modules import gpu_topology as _gt2
                warm_devices = list(_gt2.sdxl_ready_devices) or [0]
            except Exception:
                warm_devices = [0]
            if len(warm_devices) > 1:
                log.info(
                    f"shot fetch pre-warm: loading local_sdxl on "
                    f"cuda:{warm_devices} in parallel (blocks pool start)"
                )
                from concurrent.futures import ThreadPoolExecutor as _TPE
                with _TPE(max_workers=len(warm_devices),
                          thread_name_prefix="sdxl-warm") as _wex:
                    list(_wex.map(_local_sdxl_load, warm_devices))
            else:
                log.info(
                    f"shot fetch pre-warm: loading local_sdxl on "
                    f"cuda:{warm_devices[0]} (blocks pool start)"
                )
                _local_sdxl_load(warm_devices[0])
    except Exception as _e:
        log.debug(f"local_sdxl pre-warm skipped: {_e}")

    results: list[dict | None] = [None] * len(shots)
    done_count = 0
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="shotfetch") as ex:
        futures = [
            ex.submit(_fetch_one, i, s, preset_by_idx.get(i))
            for i, s in enumerate(shots)
        ]
        for fut in as_completed(futures):
            try:
                idx, src = fut.result()
            except Exception as e:
                log.warning(f"shot fetch worker crashed: {e}")
                continue
            results[idx] = src
            done_count += 1
            run_state.tick("footage", done_count / total)

    sources = [s for s in results if s is not None]
    log.info(
        f"Storyboard fetch: {len(sources)}/{len(shots)} shots filled "
        f"({sum(1 for s in sources if s.get('origin') == 'manual_upload')} from user upload) "
        f"— parallelism={max_workers}"
    )
    return sources
