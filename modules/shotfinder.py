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

    # Bolt the negative clause onto the prompt for Flux (no native field).
    final_prompt = prompt
    if negative_prompt and negative_prompt.strip():
        final_prompt = f"{prompt}. Avoid: {negative_prompt}"
    encoded = urllib.parse.quote(final_prompt, safe="")
    url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=1080&height=1920&seed={seed}&model=flux&nologo=true&private=true"
        f"&safe={'true' if F._restrictions_on() else 'false'}"
    )
    dest = os.path.join(output_dir, f"pollinations_{seed:08x}.jpg")

    try:
        # Single attempt — we don't retry inside the breaker; the breaker
        # itself is the retry policy. A 429 trips it; a 5xx is one-shot.
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

_LOCAL_SDXL_PIPE = None
_LOCAL_SDXL_BROKEN = False
_LOCAL_SDXL_BROKEN_REASON = ""


def _local_sdxl_load():
    """Lazy-load the diffusers pipeline. Kept out of module import path
    so CPU workers never pay the diffusers/torch import tax.

    Every failure path prints a distinct WARNING with actionable text
    (previously most failures were logged at INFO or swallowed silently,
    so the user saw the priority-loop skip the provider with no clue why)."""
    global _LOCAL_SDXL_PIPE, _LOCAL_SDXL_BROKEN, _LOCAL_SDXL_BROKEN_REASON
    if _LOCAL_SDXL_BROKEN:
        return None
    if _LOCAL_SDXL_PIPE is not None:
        return _LOCAL_SDXL_PIPE
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
        # avoids some VAE overflow artifacts. Fall back to fp16 on Turing
        # (T4) which reports False for is_bf16_supported.
        use_bf16 = torch.cuda.is_bf16_supported()
        dtype = torch.bfloat16 if use_bf16 else torch.float16
        # The `variant="fp16"` load path only exists for models that
        # actually publish an fp16-suffixed weights file. sdxl-turbo does;
        # some community forks do not. Fall back to variant=None on a
        # load failure so a swapped-in model still boots.
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id,
                torch_dtype=dtype,
                variant="fp16" if not use_bf16 else None,
                use_safetensors=True,
            )
        except Exception as e_variant:
            log.warning(
                f"local_sdxl: variant='fp16' load failed ({e_variant}); "
                f"retrying without variant hint …"
            )
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id, torch_dtype=dtype, use_safetensors=True,
            )
        pipe = pipe.to("cuda")
        # Memory-thrift knobs — matters on T4-16GB.
        try:
            pipe.enable_vae_slicing()
            pipe.enable_attention_slicing()
        except Exception:
            pass
        _LOCAL_SDXL_PIPE = pipe
        log.warning(f"local_sdxl: pipeline READY (dtype={dtype}, model={model_id})")
        return pipe
    except Exception as e:
        _LOCAL_SDXL_BROKEN = True
        _LOCAL_SDXL_BROKEN_REASON = f"{type(e).__name__}: {e}"
        log.warning(
            f"local_sdxl: pipeline load FAILED — provider DISABLED "
            f"({type(e).__name__}: {e}). Common causes: OOM (VRAM), "
            f"corrupted HF cache, model id typo. Try clearing "
            f"~/.cache/huggingface/hub/ and re-running."
        )
        return None


def _local_sdxl_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image on the local GPU. Returns (path, seed) on
    success, (None, seed) on failure or when disabled."""
    seed = int(hashlib.md5(f"{prompt}|{trial}|sdxl".encode()).hexdigest()[:8], 16)
    pipe = _local_sdxl_load()
    if pipe is None:
        return None, seed
    try:
        import torch
        gen = torch.Generator(device="cuda").manual_seed(seed)
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
            kwargs.update({"num_inference_steps": 4, "guidance_scale": 0.0})
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
        log.warning(f"local_sdxl gen failed: {e}")
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

    log.info(f"Shot fetch | query={query!r} | excerpt={premise[:60]!r}")

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
        return True, ""

    _AI_PROVIDERS = {
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

    log.warning(f"  No image found for shot {query!r}")
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
    from modules import run_state
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    reset_pollinations_breaker()
    reset_hf_breaker()
    used_ids = set(F._load_used_clips())
    sources = []
    presets = list(preset_sources or [])
    total = max(1, len(shots))
    for i, shot in enumerate(shots, 1):
        run_state.check_cancel()
        log.info(f"Shot {i}/{total}")
        if presets:
            src = presets.pop(0)
            log.info(f"  using preset image: {src.get('path')}")
        else:
            src = find_image_for_shot(shot, output_dir, used_ids, channel=channel)
        if src:
            src["start"] = float(shot.get("start", 0.0))
            src["end"]   = float(shot.get("end", 0.0))
            sources.append(src)
        run_state.tick("footage", i / total)
    log.info(f"Storyboard fetch: {len(sources)}/{len(shots)} shots filled "
             f"({sum(1 for s in sources if s.get('origin') == 'manual_upload')} from user upload)")
    return sources
