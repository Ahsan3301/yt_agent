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
import threading as _threading
import logging
import base64
import hashlib
import json
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


# Cloudflare Workers AI (Flux 2 dev): account pool, burn markers, quota
# counter, breaker and generate body all live in providers/cloudflare.py.
# Imported for the _AI_PROVIDERS dispatch map below; readiness goes
# through the registry, not through this name.
from modules.providers.cloudflare import _cloudflare_generate  # noqa: E402,F401

from modules.providers.prompt import (  # noqa: E402
    _distill_prompt_for_flux,
    _regex_distill,
    _FLUX_DISTILL_CACHE,
)
# Stable Horde MOVED to modules/providers/horde.py - state, breaker
# and body together. Imported back under the original name so the
# _AI_PROVIDERS dispatch table below is unchanged.
from modules.providers.horde import _horde_generate  # noqa: E402
# Pollinations MOVED to modules/providers/pollinations.py - breaker
# state, rate limiter, generate body and the run-start reset together.
# Re-exported under the original names so the dispatch table and the
# pipeline's reset call are unchanged.
from modules.providers.pollinations import (  # noqa: E402
    _pollinations_generate,
    _pollinations_breaker_skip,
    reset_pollinations_breaker,
)

# HuggingFace MOVED to modules/providers/huggingface.py - breaker
# state, body and the run-start reset together. Re-exported under the
# original names so the dispatch table and reset call are unchanged.
from modules.providers.huggingface import (  # noqa: E402
    _huggingface_generate,
    _hf_breaker_skip,
    reset_hf_breaker,
)
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

# Providers whose "skipped ({reason})" line has already been logged
# in this worker's lifetime. Second and later shots that see the same
# provider unavailable log a terse breadcrumb instead of the full
# ~200-char reason (audit follow-up 2026-07-13). Reset by process
# restart — every fresh worker boot logs the full reason once.
_SKIP_REASON_LOGGED: set[str] = set()
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
        # Pin the LOAD thread's default CUDA device to device_id so any
        # default-device allocations diffusers makes during .to() land
        # on THIS card, not cuda:0. Matches the pattern in _local_sdxl_
        # generate below — see comment there for the "Half vs Float"
        # bug this prevents.
        torch.cuda.set_device(device_id)
        # low_cpu_mem_usage=False is ~7× faster to load but needs ~3×
        # peak CPU RAM (whole state_dict materialised in one shot). On
        # Kaggle T4×2 with 31 GB RAM that's fine; on Colab T4×1 with
        # only 12.7 GB RAM the kernel OOM-killed uvicorn during load
        # (returncode=-9). Auto-detect: use the fast path only when
        # total RAM ≥ 24 GB; drop to the diffusers default (True,
        # per-layer materialise) on low-RAM hosts. ~2 min slower first
        # load on Colab vs OOM crash.
        try:
            import psutil
            _total_gb = psutil.virtual_memory().total / (1024**3)
        except Exception:
            _total_gb = 32.0  # assume roomy on probe failure
        _low_cpu = _total_gb < 24.0
        if _low_cpu:
            log.info(
                f"local_sdxl: {_total_gb:.1f} GB RAM detected — using "
                f"low_cpu_mem_usage=True (slower load, avoids OOM on Colab)"
            )
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id,
                torch_dtype=dtype,
                variant="fp16" if not use_bf16 else None,
                use_safetensors=True,
                low_cpu_mem_usage=_low_cpu,
            )
        except Exception as e_variant:
            log.warning(
                f"local_sdxl: variant='fp16' load failed ({e_variant}); "
                f"retrying without variant hint …"
            )
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id, torch_dtype=dtype, use_safetensors=True,
                low_cpu_mem_usage=_low_cpu,
            )
        pipe = pipe.to(f"cuda:{device_id}")
        # SDXL fp16 VAE NaN fix — the classic "SDXL outputs all-black
        # images on Turing" bug. On T4 (sm_7.5) and older, SDXL's VAE
        # decoder can overflow to NaN in fp16, producing entirely
        # black images. Ampere+ (bf16) doesn't hit this because bf16
        # has a wider dynamic range. Fix: cast VAE to fp32 on non-bf16
        # devices. Costs ~200 MB VRAM (tiny) but eliminates black
        # outputs. Confirmed live 2026-07-10 on Colab T4: 11/11 shots
        # rendered as full-black PNGs before this fix, subs+audio
        # burned onto pure black.
        if not use_bf16:
            try:
                pipe.vae = pipe.vae.to(torch.float32)
                log.info(
                    f"local_sdxl[cuda:{device_id}]: VAE cast to fp32 to avoid "
                    f"Turing/fp16 NaN overflow (black-image bug)"
                )
            except Exception as _vae_e:
                log.warning(f"local_sdxl: VAE fp32 cast failed: {_vae_e}")
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
        _msg = f"{type(e).__name__}: {e}"
        # Import-time errors are TERMINAL for the whole provider (both
        # GPUs), not per-device. Example: transformers>=4.50 removed
        # AlbertModel + PreTrainedModel lazy-imports that Kokoro and
        # diffusers depend on. Retrying on the sibling GPU crashes with
        # the same error. Kill the whole provider so the shot fetch
        # loop falls through to pollinations after the first attempt.
        if any(m in _msg for m in ("Could not import module",
                                   "Failed to import",
                                   "No module named")):
            _LOCAL_SDXL_BROKEN = True
            _LOCAL_SDXL_BROKEN_REASON = _msg[:200]
            log.warning(
                f"local_sdxl: TERMINAL import error, provider DISABLED "
                f"for this process — {_msg[:200]}. All shots skip to next "
                f"AI provider (pollinations/horde/hf)."
            )
            return None
        # Per-device failure: mark THIS device broken (not the whole
        # provider) so a sibling GPU can keep serving. Only when every
        # device is broken does the provider actually stop responding.
        _LOCAL_SDXL_DEVICE_BROKEN[device_id] = _msg[:200]
        log.warning(
            f"local_sdxl[cuda:{device_id}]: pipeline load FAILED "
            f"({_msg}). Common causes: OOM (VRAM), corrupted HF cache, "
            f"model id typo. Sibling GPUs (if any) keep serving; if "
            f"none, priority loop skips to next provider."
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
        # Pin THIS thread's default CUDA device to device_id for the
        # duration of the generate call. Diffusers' internal allocations
        # (torch.zeros/ones/tensor without device=) go to the CURRENT
        # default device — otherwise they land on cuda:0 and collide
        # with the fp16 pipe on cuda:1, throwing "expected scalar type
        # Half but found Float" on every attempt. Confirmed live: with-
        # out this, cuda:0 worked but cuda:1 failed every retry. Each
        # ThreadPoolExecutor worker has its own current_device, so
        # per-thread set_device is safe.
        torch.cuda.set_device(device_id)
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
            # Passing "" (not None) matters on SDXL-turbo. With
            # negative_prompt=None + guidance_scale=0, diffusers builds
            # DEFAULT negative embeddings in torch's default dtype
            # (float32) instead of matching the pipe's fp16 weights —
            # then the first cross-attention op throws "expected scalar
            # type Half but found Float". Empty-string forces the
            # tokenizer path which produces embeddings in the right
            # dtype. Confirmed live on both cuda:0 and cuda:1.
            "negative_prompt": negative_prompt or "",
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
        # Belt-and-suspenders: autocast to fp16 forces every internal op
        # to fp16 regardless of what dtype a rogue tensor was allocated
        # in. Cheap on T4 and catches any negative-embedding / latent
        # / conditioning-tensor path we haven't seen yet. Torch's
        # autocast is context-manager based and thread-safe.
        _pipe_dtype = torch.float16  # T4 uses fp16; sm_8+ uses bfloat16
        try:
            _pipe_dtype = next(pipe.unet.parameters()).dtype
        except Exception:
            pass
        with torch.autocast(device_type="cuda", dtype=_pipe_dtype):
            image = pipe(**kwargs).images[0]
        # Sanity check for degenerate outputs BEFORE saving. Turing +
        # fp16 SDXL can produce NaN → PIL renders as fully black; a
        # partial VAE overflow can produce near-uniform grey/purple.
        # Reject anything with too little colour variance so the
        # vision-judge-disabled fallback path doesn't accept a pure
        # black image and end up with a black final video. Confirmed
        # live 2026-07-10.
        try:
            import numpy as _np
            _arr = _np.asarray(image).astype(_np.float32)
            _std = float(_arr.std())
            _mean = float(_arr.mean())
            if _std < 8.0 or _mean < 6.0:
                log.warning(
                    f"local_sdxl[cuda:{device_id}]: degenerate output "
                    f"(mean={_mean:.1f}, std={_std:.1f}) — likely VAE overflow "
                    f"or all-black; treating as failure"
                )
                return None, seed
        except Exception:
            pass  # sanity check is best-effort; don't block save on numpy failure
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
        # Import-time markers: diffusers/transformers version conflict
        # (e.g. transformers>=4.50 removed AlbertModel + PreTrainedModel
        # lazy-import) breaks the ENTIRE provider on every shot, not
        # just this device. Kill the whole provider so the fetch loop
        # falls through to pollinations instead of retrying the same
        # broken import 5×N shots. Confirmed live 2026-07-09.
        import_markers = (
            "Could not import module",
            "Failed to import",
            "No module named",
        )
        if any(m in msg for m in import_markers):
            global _LOCAL_SDXL_BROKEN, _LOCAL_SDXL_BROKEN_REASON
            _LOCAL_SDXL_BROKEN = True
            _LOCAL_SDXL_BROKEN_REASON = msg[:200]
            log.warning(
                f"local_sdxl: TERMINAL import error, provider DISABLED for "
                f"this process — {msg[:200]}. All shots will skip to next "
                f"AI provider (pollinations/horde/hf)."
            )
            return None, seed
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


# ── Local Flux 2 klein-4B (via diffusers) — free GPU-only backup ─────
# Runs on the Kaggle T4×2 accelerator via device_map='balanced' which
# splits the ~13 GB model (transformer + Qwen3-4B text encoder + VAE)
# across both cards. Kicks in when the Cloudflare klein-9b pool has
# been drained for the day — same Flux 2 quality tier, unlimited, free.
# Skipped automatically on single-GPU workers (Colab T4×1) and CPU
# workers (Oracle) because gpu_topology.flux2_supported is False there.
# Model download (~7.8 GB) happens in a background thread from the
# Kaggle notebook's cell 4.5, so the first render doesn't pay the cost.
_LOCAL_FLUX2_PIPES: dict = {}
_LOCAL_FLUX2_BROKEN = False
_LOCAL_FLUX2_BROKEN_REASON = ""
_LOCAL_FLUX2_DEVICE_BROKEN: dict = {}
# Shared load lock — unlike SDXL (per-device locks because we load ONE
# pipe per GPU independently), klein-4B uses device_map='balanced' which
# does its own multi-GPU splitting inside a single from_pretrained call.
# One lock is enough.
_LOCAL_FLUX2_LOAD_LOCK = _sdxl_threading.Lock()


def _local_flux2_klein_load(device_id: int | None = None):
    """Lazy-load Flux2KleinPipeline. Returns pipe on success, None on
    failure. On T4×2 the pipeline is split across BOTH devices via
    device_map='balanced'; device_id is used to key the cache but the
    actual placement is decided by accelerate.
    """
    global _LOCAL_FLUX2_BROKEN, _LOCAL_FLUX2_BROKEN_REASON

    if _LOCAL_FLUX2_BROKEN:
        return None

    # Fast path: cached pipe already loaded on this device (or the
    # "shared" -1 slot when device_map='balanced' spans multiple GPUs).
    cache_key = -1  # single balanced pipeline serves all shots
    pipe = _LOCAL_FLUX2_PIPES.get(cache_key)
    if pipe is not None:
        return pipe

    with _LOCAL_FLUX2_LOAD_LOCK:
        # Double-check inside the lock.
        pipe = _LOCAL_FLUX2_PIPES.get(cache_key)
        if pipe is not None:
            return pipe
        try:
            import torch
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"torch not importable: {e}"
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None
        if not torch.cuda.is_available():
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = "no CUDA device visible"
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None
        try:
            from modules import gpu_topology as _gt
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"gpu_topology import failed: {e}"
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None
        if not _gt.flux2_supported:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = (
                f"needs at least 2 sm_7+ GPUs (found {len(_gt.sdxl_ready_devices)})"
            )
            log.info(f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}")
            return None

        try:
            from diffusers import Flux2KleinPipeline
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = (
                f"Flux2KleinPipeline not available in diffusers "
                f"(need >=0.36): {e}"
            )
            log.warning(
                f"local_flux2_klein: DISABLED — {_LOCAL_FLUX2_BROKEN_REASON}. "
                f"Kaggle notebook cell 2 must install diffusers>=0.36 + "
                f"transformers>=4.51."
            )
            return None

        model_id = os.getenv("LOCAL_FLUX2_KLEIN_MODEL", "") or ""
        if not model_id:
            try:
                model_id = str(
                    (load_settings().get("image_gen", {}) or {})
                    .get("local_flux2_klein_model", "")
                ).strip() or "black-forest-labs/FLUX.2-klein-4B"
            except Exception:
                model_id = "black-forest-labs/FLUX.2-klein-4B"

        # device_map='balanced' spreads transformer + text_encoder + VAE
        # across all visible GPUs based on parameter size. On T4×2 this
        # typically lands Qwen3 on one card and transformer+VAE on the
        # other. max_memory leaves ~2 GB per card as buffer for
        # activations + concurrent Kokoro co-tenancy.
        max_mem = {i: "14GB" for i in _gt.flux2_ready_devices}
        log.info(
            f"local_flux2_klein: loading {model_id} "
            f"(device_map=balanced, max_memory={max_mem}, "
            f"torch_dtype=fp16 for T4 sm_7.5)"
        )
        os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "360")
        try:
            pipe = Flux2KleinPipeline.from_pretrained(
                model_id,
                torch_dtype=torch.float16,
                device_map="balanced",
                max_memory=max_mem,
            )
        except Exception as e:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"from_pretrained failed: {e}"
            log.warning(
                f"local_flux2_klein: from_pretrained crashed — {e}. "
                f"Provider DISABLED for this worker's lifetime; "
                f"chain falls through to next provider."
            )
            return None

        # VAE fp32 upcast to prevent the same Turing (T4 sm_7.5) fp16
        # overflow that makes SDXL produce fully-black images. See the
        # SDXL VAE handling above for the empirical reference.
        try:
            pipe.vae = pipe.vae.to(torch.float32)
            log.info("local_flux2_klein: VAE upcast to fp32 (Turing fp16-overflow fix)")
        except Exception as _e:
            log.debug(f"local_flux2_klein: VAE upcast skipped: {_e}")

        _LOCAL_FLUX2_PIPES[cache_key] = pipe
        log.info(
            "local_flux2_klein: pipeline READY (device_map=balanced across "
            f"{_gt.flux2_ready_devices}; 4 steps CFG 1.0 per BFL guidance)"
        )
        return pipe


def _local_flux2_klein_generate(prompt, output_dir, trial, negative_prompt=""):
    """Generate one image via Flux 2 klein-4B on the local GPU pair.
    Returns (path, seed) on success, (None, seed) on failure.

    Klein is a distilled model — steps=4 + guidance=1.0 is BFL's
    documented sweet spot. Extra steps HURT quality (per InferenceBench).
    No negative prompt (Flux family doesn't use them).
    """
    seed = int(hashlib.md5(f"{prompt}|{trial}|flux2klein".encode()).hexdigest()[:8], 16)
    pipe = _local_flux2_klein_load()
    if pipe is None:
        return None, seed
    try:
        import torch
        gen = torch.Generator(device="cuda").manual_seed(seed)
        # 1024×576 = 9:16 portrait, matches klein-9b on CF + editor's
        # target aspect for YouTube Shorts.
        #
        # Prompt distillation — same _distill_prompt_for_flux() used by
        # klein-9b on Cloudflare AND Pollinations/HF Flux paths. Klein-4B
        # is the exact same distilled Flux 2 model family as klein-9b —
        # both benefit from the same Qwen-encoder-friendly polish (natural
        # language sentences, no tag lists, capped length). This was
        # missed in the initial klein-4B provider ship; without it, klein-4B
        # on Kaggle got raw craft_image_prompt output while klein-9b on
        # Cloudflare got the polished version — noticeable quality gap.
        # Confirmed 2026-07-13. 600 char cap matches Pollinations Flux
        # path (klein-4B has similar context window to Pollinations Flux).
        distilled = _distill_prompt_for_flux(prompt)[:600]
        # num_inference_steps=5 (not the 4 BFL documents) — same fix as
        # SDXL-turbo above. Klein-4B's scheduler creates a sigmas array
        # of length steps+1. At steps=4 → length=5 → some code path in
        # the transformer inference tries to access sigmas[num_inference_steps]
        # = sigmas[5] and crashes with:
        #   "IndexError: index 5 is out of bounds for dimension 0 with size 5"
        # Bumping to 5 makes the array length 6 → index 5 valid → the
        # bug can't fire. +25% inference time (~2s/image on T4) is a fair
        # trade vs losing every retry to the crash. Confirmed live during
        # the 2026-07-13 verify-render session.
        kwargs = {
            "prompt": distilled,
            "num_inference_steps": 5,
            "guidance_scale": 1.0,
            "height": 1024,
            "width": 576,
            "generator": gen,
        }
        # Klein-4B's Flux 2 lineage does not use negative prompts — the
        # rectified-flow objective ignores them. We accept the kwarg for
        # signature parity with other providers but silently drop it.
        with torch.autocast(device_type="cuda", dtype=torch.float16):
            image = pipe(**kwargs).images[0]

        # Same degenerate-output check the SDXL provider uses. Turing
        # fp16 numerical instability can still occasionally slip past
        # the VAE fp32 cast and produce black/near-uniform images.
        try:
            import numpy as _np
            _arr = _np.asarray(image).astype(_np.float32)
            _std = float(_arr.std())
            _mean = float(_arr.mean())
            if _std < 8 or _mean < 6:
                log.warning(
                    f"local_flux2_klein: degenerate image "
                    f"(std={_std:.1f}, mean={_mean:.1f}) — treating as failure"
                )
                return None, seed
        except Exception:
            pass

        dest = os.path.join(output_dir, f"flux2klein_{seed:08x}.jpg")
        image.save(dest, "JPEG", quality=92)
        return dest, seed
    except Exception as e:
        msg = str(e)
        # Distinguish OOM (per-device kill) vs transient errors.
        if "out of memory" in msg.lower() or "OutOfMemoryError" in msg:
            _LOCAL_FLUX2_BROKEN = True
            _LOCAL_FLUX2_BROKEN_REASON = f"OOM: {msg[:120]}"
            log.warning(
                f"local_flux2_klein: OOM during gen — provider DISABLED "
                f"for this worker's lifetime. Reduce shot_parallelism or "
                f"upgrade to a GPU tier with more VRAM."
            )
            try:
                import torch as _t
                _t.cuda.empty_cache()
            except Exception:
                pass
        else:
            log.warning(f"local_flux2_klein gen failed: {e}")
        return None, seed


# Agnes MOVED to modules/providers/agnes.py - cooldown state, the
# video rate gate and both generate bodies together. Image and video
# share the cooldown, so they moved as one unit.
from modules.providers.agnes import (  # noqa: E402
    _agnes_generate,
    _agnes_video_generate,
    _agnes_video_shots,
    _agnes_key,
)


def _archive_clips_enabled() -> bool:
    """Whether opening shots may fall back to Internet Archive footage.

    On by default: it costs no credentials and is bounded by the
    provider's own time budget. Set ARCHIVE_SHOT_CLIPS=0 to force the
    old stills-only behaviour.
    """
    return (os.getenv("ARCHIVE_SHOT_CLIPS", "1").strip().lower()
            not in ("0", "false", "no", "off"))


def _archive_clip_for_shot(shot: dict, output_dir: str, idx: int, used_ids: set):
    """Real public-domain motion footage for one shot, or None.

    The image chain produces stills that get pan/zoomed. That is what
    makes output read as auto-generated, and it is the complaint the
    Archive provider exists to answer: genuine moving footage, free,
    no credentials.

    Sits BELOW Agnes in the motion slot rather than replacing it.
    Agnes generates a clip matching the prompt exactly; the Archive can
    only return whatever real footage happens to exist, so it is the
    fallback — but it is the only motion source that works with no key
    at all, which is the current configuration.

    Never raises: a miss must fall through to a still, because a
    missing shot kills the render.
    """
    try:
        from modules.footage import fetch_archive_videos
    except Exception:
        return None
    # The visual prompt is written for an image model — long, full of
    # style adjectives ("cinematic, volumetric fog, 8k"). Archive search
    # matches titles, so feed it the subject only.
    # These are the keys the storyboard actually emits — see
    # find_image_for_shot, which reads the same ones. An earlier version
    # of this guessed at "query"/"visual"/"prompt"/"description", none of
    # which exist, so `raw` was always empty and the function returned
    # instantly for every shot. The render logged "no motion source" with
    # no error, because returning None IS the documented miss path.
    #
    # search_query first: it is already a short stock-search phrase,
    # which is exactly what an archive title index wants.
    # visual_description and ai_prompt are written for a diffusion model
    # and need the stopword pass below to be usable.
    raw = (shot.get("search_query") or shot.get("visual_description")
           or shot.get("ai_prompt") or "")
    if not raw:
        log.info(f"archive-clip: shot {idx} has no usable query keys ({sorted(shot)[:6]})")
        return None
    # Imported locally: this module has no module-level `re`, only
    # function-local ones (see line ~580). A module-level re.findall
    # here would NameError on every call.
    import re as _re
    words = [w for w in _re.findall(r"[A-Za-z]{3,}", str(raw))
             if w.lower() not in _ARCHIVE_STOPWORDS]
    if not words:
        return None

    # Progressive narrowing. Archive search ORs its terms and ranks by
    # downloads, so every extra word reshuffles the results: "abandoned
    # house" returns a matching clip, while "abandoned house fog"
    # returns nothing because the good hit drops past the provider's
    # probe cap. Try the fuller query first for precision, then fall
    # back to the two-word core rather than giving up.
    tried = []
    for n in (3, 2):
        query = " ".join(words[:n]).strip()
        if not query or query in tried:
            continue
        tried.append(query)
        try:
            got = fetch_archive_videos(query, output_dir, count=1, used_ids=used_ids)
        except Exception as e:
            log.info(f"archive-clip: shot {idx} lookup failed: {e}")
            return None
        if got:
            log.info(f"archive-clip: shot {idx} matched on {query!r}")
            return {"type": "video", "path": got[0],
                    "origin": "archive-video", "score": 6}
    return None


# Style vocabulary that image prompts are full of and that means
# nothing to a footage archive's title index.
_ARCHIVE_STOPWORDS = {
    "cinematic", "photorealistic", "realistic", "detailed", "highly", "ultra",
    "volumetric", "dramatic", "moody", "atmospheric", "eerie", "ominous",
    "shot", "photo", "photograph", "image", "view", "scene", "style",
    "lighting", "light", "dark", "colour", "color", "grain", "film",
    "wide", "close", "closeup", "angle", "lens", "depth", "field", "bokeh",
    "the", "and", "with", "from", "that", "this", "into", "over", "under",
    "digital", "art", "render", "rendering", "quality", "masterpiece",
}


# ── character anchors ────────────────────────────────────────
# First generated image per character, reused as an image-to-image
# reference for every later shot featuring them. Cleared at the start
# of each render so one video's cast can never leak into the next.
#
# Keyed by the cast name the storyboard assigned. Thread-safe because
# shots are fetched in a pool and two shots with the same character can
# finish out of order — whoever lands first becomes the anchor.
_CAST_ANCHORS: dict[str, str] = {}
_CAST_ANCHOR_LOCK = __import__("threading").Lock()


# ── generated-clip quality gate ──────────────────────────────
# Per-render tally of shots whose clip could not be brought up to
# standard. The operator chose best-effort publishing, so a failure
# here does not stop the render — it marks it, and main.py copies the
# marks onto the run summary so the dashboard can show the video as
# degraded before anyone puts it in front of an audience.
_DEGRADED: list[dict] = []
_DEGRADED_LOCK = __import__("threading").Lock()


def reset_degraded() -> None:
    with _DEGRADED_LOCK:
        _DEGRADED.clear()


def take_degraded() -> list[dict]:
    """Drain the tally. Called once by the pipeline after fetch_shots."""
    with _DEGRADED_LOCK:
        out = list(_DEGRADED)
        _DEGRADED.clear()
    return out


def _register_degraded(idx: int, verdict: dict) -> None:
    with _DEGRADED_LOCK:
        _DEGRADED.append({
            "shot":      idx + 1,
            "reason":    str(verdict.get("reason") or "unknown"),
            "motion":    verdict.get("motion"),
            "vision":    verdict.get("vision"),
            "mean_diff": verdict.get("mean_diff"),
        })


def _clip_qc_tries() -> int:
    """Generations allowed per shot before we accept the best one.

    Each retry costs a full generation — ~90s plus the provider's rate
    limit — so this is bounded low by default. Two is enough to catch
    the common "it came back frozen" failure without doubling render
    time on a channel where the first attempt is usually fine.
    """
    try:
        v = int((load_settings().get("video") or {}).get("clip_qc_attempts", 2))
    except Exception:
        v = 2
    return max(1, min(4, v))


def _qc_medium(channel: str) -> str:
    """How to tell the vision judge what MEDIUM to expect.

    Without this the judge scores an animated frame against an implicit
    assumption of photorealism and marks it down for not being a
    photograph. Measured on one real frame — a 3D-animated cat on a
    lighthouse railing, verified good by eye:

        beat's own action text ............................  1/10
        literal description of the frame ..................  2/10
        same description prefixed "3D animated film still" . 10/10
        deliberately wrong description (a car in a desert) .  0/10

    The judge discriminates correctly; it was answering a question we
    never asked properly. Empty for photographic niches, which keeps
    their scoring exactly as it was.
    """
    try:
        from modules import channels as _ch
        return str((_ch.get_channel(channel) or {}).get("medium_hint") or "").strip()
    except Exception:
        return ""


def _qc_clip(path: str, shot: dict, channel: str = "") -> dict:
    """Judge one generated clip against the shot it was made for."""
    try:
        from modules import clip_qc
        _vcfg = load_settings().get("video") or {}
        # Score against the CHARACTER as well as the action.
        #
        # visual_description is the beat's action alone, and a cat that
        # has sprouted a coat and stood up on two legs still "climbs the
        # wet rocks" — so the judge passed exactly the clips that had
        # drifted, while flagging two that were fine. It was never shown
        # what the character is supposed to look like, so it could not
        # possibly catch a change in it.
        #
        # ai_prompt now leads with the cast bible (see
        # silent_story.shots_from_beats), so using it here gives the
        # judge identity first and action second — the same ordering the
        # image model got.
        _desc = str(shot.get("ai_prompt") or shot.get("visual_description") or "")[:600]
        _med = _qc_medium(channel)
        if _med:
            _desc = f"{_med}: {_desc}"
        return clip_qc.check(
            path,
            fit_description=_desc,
            premise=str(shot.get("narration_excerpt") or "")[:300],
            min_vision=int(_vcfg.get("clip_qc_min_vision",
                                     clip_qc.DEFAULT_MIN_VISION)),
            use_vision=bool(_vcfg.get("clip_qc_vision", True)),
        )
    except Exception as e:
        # A broken gate must never block a render. Unknown = pass.
        log.warning(f"clip QC skipped for shot: {e!r}")
        return {"ok": True, "reason": f"qc error: {e}"}


def build_cast_sheet(shots, output_dir, channel: str = "") -> int:
    """Generate one reference portrait per recurring character.

    Anchoring on "whatever shot 1 produced" is weak: the opening shot is
    usually a wide establishing frame where the character is small,
    backlit or facing away, which is a poor thing to match a face
    against. A purpose-built portrait — frontal, evenly lit, plain
    background — gives every later shot a clean likeness to lock onto.

    It also decouples the anchor from shot order, so re-rolling shot 1
    can no longer change what the whole cast looks like.

    Costs one image per character. Returns how many were built.
    """
    if not _agnes_key():
        return 0
    looks: dict[str, str] = {}
    for sh in (shots or []):
        for nm in (sh.get("cast_names") or []):
            if nm in looks:
                continue
            # The storyboard appends "Character reference — Name: look"
            # to ai_prompt; recover this character's clause from it.
            _ap = str(sh.get("ai_prompt") or "")
            _marker = f"{nm}:"
            if _marker in _ap:
                seg = _ap.split(_marker, 1)[1]
                looks[nm] = seg.split(";")[0].strip(" .")[:300]
    # Animated niches need a FULL-BODY reference, not a head-and-
    # shoulders one. Their shots are full-figure action — a character
    # running, reaching, falling — and a reference cropped at the
    # collar tells the model nothing about build, proportions, or what
    # the character is wearing below the chest. Those are exactly the
    # things that drift, and the drift is more visible in animation
    # than in photography because the silhouette IS the character.
    _style = ""
    _animated = False
    try:
        from modules import channels as _ch
        _cfg = _ch.get_channel(channel) if channel else {}
        _animated = bool(_cfg.get("silent")) or "animated" in str(_cfg.get("image_style", ""))
        _style = str(_cfg.get("image_style") or "")
    except Exception:
        pass

    built = 0
    for nm, look in list(looks.items())[:3]:      # 3 portraits is plenty for a Short
        if not look:
            continue
        if _animated:
            prompt = (
                f"Character model sheet: full body, head to toe, of {look}. "
                "Standing straight facing the camera, arms relaxed at the sides, "
                "neutral expression, feet fully visible, even soft studio lighting, "
                "plain light grey background, entire figure inside the frame. "
                + _style
            )
        else:
            prompt = (
                f"Head and shoulders portrait photograph of {look}. "
                "Facing camera, neutral expression, even soft lighting, "
                "plain neutral background, sharp focus, photorealistic."
            )
        try:
            path, _seed = _agnes_generate(prompt, output_dir, trial=0)
        except Exception as e:
            log.warning(f"cast-sheet: {nm} failed: {e}")
            continue
        if path:
            _cast_anchor_put([nm], path)
            built += 1
            log.info(f"cast-sheet: built reference portrait for {nm}")
    return built


def reset_cast_anchors() -> None:
    with _CAST_ANCHOR_LOCK:
        _CAST_ANCHORS.clear()


def _cast_anchor_get(names) -> str:
    with _CAST_ANCHOR_LOCK:
        for n in (names or []):
            p = _CAST_ANCHORS.get(n)
            if p and os.path.exists(p):
                return p
    return ""


def _cast_anchor_put(names, path: str) -> None:
    if not path or not os.path.exists(path):
        return
    with _CAST_ANCHOR_LOCK:
        for n in (names or []):
            _CAST_ANCHORS.setdefault(n, path)


def _niche_image_style(channel: str) -> str:
    """The niche's LOOK, as a prompt tail.

    Exists because craft_image_prompt conflated two responsibilities —
    rewriting the shot and applying the style — so declining the
    rewrite silently dropped the style as well.
    """
    if not channel:
        return ""
    try:
        from modules import channels as _ch
        return str((_ch.get_channel(channel) or {}).get("image_style") or "").strip()
    except Exception:
        return ""


def _directed_prompt(channel: str) -> bool:
    """True when this niche composes its own per-shot prompts.

    Such a niche has already decided the subject, the framing and the
    camera; running an LLM rewriter over that throws the direction away.
    Implied by `generated_only`, since a niche that generates every
    frame is one that cares what is in it.
    """
    if not channel:
        return False
    try:
        from modules import channels as _ch
        cfg = _ch.get_channel(channel) or {}
        return bool(cfg.get("directed_prompt") or cfg.get("generated_only"))
    except Exception:
        return False


# Shots whose meaning lives in the FRAMING rather than in the subject's
# face. Anchoring these to a character reference overrides the framing —
# image-to-image copies the reference's pose — and buys nothing, because
# at this scale the identity is not legible anyway.
_FRAMING_CUES = (
    "extreme wide", "very wide", "wide establishing", "aerial", "bird's eye",
    "birds eye", "overhead", "top-down", "top down", "from high above",
    "macro", "extreme close", "close-up of", "close up of", "only the hands",
    "hands only", "silhouette", "backlit", "no face", "no body",
    "tiny in frame", "small in frame", "percent of the frame",
)


def _framing_over_identity(shot: dict) -> bool:
    """True when this shot's composition must beat identity lock.

    Read from the shot's own text rather than a flag, so a beat sheet
    that says "EXTREME WIDE ... the character is a speck" gets the right
    treatment without the writer having to know this function exists.
    """
    try:
        blob = " ".join(str(shot.get(k) or "") for k in
                        ("camera", "visual_description", "ai_prompt")).lower()
    except Exception:
        return False
    return any(cue in blob for cue in _FRAMING_CUES)


def _motion_hint(channel: str) -> str:
    """Per-niche direction appended to every VIDEO prompt.

    The highest-impact preset field there is. The first wordless film
    used "slow push in" and "almost still" on every shot and played
    dead; naming a fast physical action AND giving the camera a job
    roughly doubled measured motion on identical machinery — frame
    deltas 15-23 became 41-45.

    Wired here rather than left on the preset because a preset field
    nothing reads is decoration, which this codebase has now produced
    five separate times (footage_mode, music_keywords, the Agnes image
    negatives, medium_hint, motion_required).
    """
    if not channel:
        return ""
    try:
        from modules import channels as _ch
        return str((_ch.get_channel(channel) or {}).get("motion_hint") or "").strip()
    except Exception:
        return ""


def _motion_required(channel: str) -> bool:
    """True when a still may NEVER stand in for a generated clip.

    Separate from _generated_only: that one says "do not use stock",
    this one says "do not use a frozen frame". A niche can want the
    first without the second, but a wordless animated short needs both
    — its whole claim is that every shot moves.
    """
    if not channel:
        return False
    try:
        from modules import channels as _ch
        cfg = _ch.get_channel(channel) or {}
        return bool(cfg.get("motion_required") or cfg.get("silent"))
    except Exception:
        return False


def _generated_only(channel: str) -> bool:
    """True when every frame of this niche must be generated.

    Stock footage of a specific invented character does not exist, so
    for these niches searching for it can only ever return the wrong
    thing convincingly enough to be used.
    """
    if not channel:
        return False
    try:
        from modules import channels as _ch
        cfg = _ch.get_channel(channel) or {}
        return bool(cfg.get("generated_only") or cfg.get("silent"))
    except Exception:
        return False


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

def find_image_for_shot(shot, output_dir, used_ids, channel="horror",
                        tone_override: str = "", language: str = ""):
    # Cancel check at entry — a user clicking Cancel between shots
    # shouldn't have to wait for the current shot to fully resolve
    # before the pipeline unwinds.
    from modules import run_state as _rs
    _rs.check_cancel()

    vid_cfg = load_settings().get("video", {})
    providers = load_settings().get("providers", {}) or {}
    threshold = int(vid_cfg.get("vision_judge_threshold", 4))
    judge_on = bool(vid_cfg.get("vision_judge_enabled", True)) and nim.is_available()

    # Anchor for any character already drawn in an earlier shot. Empty
    # on the first appearance, which is what makes that shot the anchor.
    _cast_ref = _cast_anchor_get(shot.get("cast_names") or [])

    visual = shot.get("visual_description") or shot.get("search_query") or ""
    query = shot.get("search_query") or ""
    ai_prompt = shot.get("ai_prompt") or visual
    premise = shot.get("narration_excerpt") or ""
    # Per-shot era anchor (backfilled from story_period in storyboard.py
    # if the model forgot). Empty string is fine — the prompt template
    # skips the period line when missing.
    period = str(shot.get("period") or "").strip()

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

    # GENERATED-ONLY NICHES: no stock, ever.
    #
    # Stock is tried FIRST and only consults the global providers
    # toggle, so a niche whose entire premise is generated imagery
    # silently got photographs. Caught on the first real render of the
    # wordless animation niche: both clips were image-to-video driven by
    # Pexels stock — a photorealistic child in a raincoat and a
    # photorealistic border collie, in a story about one specific
    # animated terrier. The character bible, the cast sheet and the
    # style prompt were all correct and all bypassed, because a stock
    # photo answered before any of them was consulted.
    #
    # This is a per-niche PROPERTY, not an operator preference: for
    # these niches a stock photograph is not a lower-quality result, it
    # is the wrong medium. Hence a preset flag rather than a settings
    # toggle someone has to remember to turn off.
    if _generated_only(channel):
        query = ""              # nothing to search stock WITH
        providers = dict(providers)
        for _p in ("shutterstock", "pexels", "coverr", "pixabay",
                   "openverse_image", "openverse"):
            providers[_p] = False

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
        # Aggressively relax vision judging on the AI-fallback path.
        # Even threshold=1 was rejecting every SDXL generation live —
        # the judge scores 0/10 constantly (payload too big for NIM
        # vision, or fallback lands on a text-only model, or the
        # rubric is calibrated for stock photos not SDXL-turbo output).
        # Setting threshold to -1 accepts ANY image the provider
        # produced INCLUDING parse-failures — better a mediocre AI
        # shot than a dropped shot that dies the render. Confirmed
        # live 2026-07-09: SDXL was generating perfectly fine images
        # that the judge was rejecting for 30+ min per shot.
        threshold = -1
        log.info(
            f"  stock returned no candidates; boosting AI budget to "
            f"{ai_attempts} attempts + DISABLING vision-judge rejection "
            f"(threshold=-1) so first successful gen wins the shot"
        )
    ig_cfg = (load_settings().get("image_gen") or {})
    priority = ig_cfg.get("priority") or [
        "cloudflare", "local_flux2_klein", "agnes", "pollinations",
        "horde", "local_sdxl", "huggingface",
    ]
    ig_enabled = ig_cfg.get("enabled") or {}
    negative_prompt = str(ig_cfg.get("negative_prompt") or "").strip()
    # Per-niche negatives, merged on top of the global list rather than
    # replacing it. What ruins a render is niche-specific: an animated
    # short is wrecked by "photorealistic human" and by melted hands,
    # neither of which belongs in a global negative that also governs
    # the photographic niches.
    try:
        from modules import channels as _chn
        _neg_style = str((_chn.get_channel(channel) or {}).get("negative_style") or "").strip()
        if _neg_style:
            negative_prompt = f"{negative_prompt}, {_neg_style}".strip(" ,")
    except Exception:
        pass

    def _provider_ready(name: str) -> tuple[bool, str]:
        """Return (ready, reason-if-not). Combines user toggle + key/GPU check."""
        # Master enable in settings.image_gen.enabled AND the legacy
        # providers.<name> toggle both count as "off". Either off → skip.
        #
        # The operator toggles stay HERE on purpose. They are policy —
        # "should this be used" — and a provider must not get to
        # overrule the operator by declaring itself ready. Providers
        # only answer capability: key present, breaker closed, GPU free.
        if ig_enabled.get(name, True) is False:
            return False, "disabled in settings"
        if providers.get(name, True) is False:
            return False, "disabled in providers toggle"

        # Migrated providers own their own capability rule. Anything not
        # yet moved falls through to the in-file chain below, so the two
        # coexist and providers can move one at a time.
        try:
            from modules import providers as _prov_pkg
            _p = _prov_pkg.get(name)
            if _p is not None:
                return _p.is_ready()
        except Exception as _e:      # noqa: BLE001
            # Never let the registry take down provider selection — fall
            # through to the legacy chain, which is still correct.
            log.debug(f"provider registry lookup failed for {name!r}: {_e}")
        # NOTE: cloudflare's readiness moved to
        # modules/providers/cloudflare.py and is reached through the
        # registry lookup above. It is NOT duplicated here on purpose —
        # two copies of a four-branch rule would drift, and the copy
        # that drifted would be the one nobody was reading.
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
        if name == "local_flux2_klein":
            if _LOCAL_FLUX2_BROKEN:
                return False, f"local flux2 pipeline broken ({_LOCAL_FLUX2_BROKEN_REASON})"
            # Klein-4B needs the T4×2 split (device_map='balanced' can't
            # do its job on a single GPU that lacks room for both the
            # transformer and the Qwen3 text encoder). Colab (T4×1) and
            # Oracle (CPU-only) auto-skip here without even attempting
            # the model download.
            try:
                from modules import gpu_topology as _gt
                if not _gt.flux2_supported:
                    return False, (
                        f"needs >=2 GPUs, have {len(_gt.sdxl_ready_devices)} "
                        f"(Kaggle T4×2 only — Colab/Oracle skip)"
                    )
            except Exception:
                pass
        # pollinations, horde and huggingface readiness now lives in
        # modules/providers/*.py and is reached through the registry
        # lookup above. Only the two LOCAL GPU providers remain in this
        # chain — they depend on gpu_topology and per-device broken
        # state, and are the only providers whose availability differs
        # between Oracle, Colab and Kaggle.
        return True, ""

    _AI_PROVIDERS = {
        "cloudflare":         _cloudflare_generate,   # Flux 2 dev via Workers AI, ~150/day free
        "local_flux2_klein":  _local_flux2_klein_generate,  # Kaggle T4×2 only
        "agnes":              _agnes_generate,        # Agnes AI, per-channel key, big free quota
        "horde":              _horde_generate,        # real SDXL crowdsourced, works anon
        "huggingface":        _huggingface_generate,
        "local_sdxl":         _local_sdxl_generate,
        "pollinations":       _pollinations_generate,
    }

    for slot, provider_name in enumerate(priority):
        fn = _AI_PROVIDERS.get(provider_name)
        if fn is None:
            log.info(f"  [ai-{slot+1}] unknown provider {provider_name!r} — skipping")
            continue
        ready, reason = _provider_ready(provider_name)
        if not ready:
            # Log the full reason ONCE per provider per worker lifetime.
            # Subsequent skips (which happen on every shot of every render
            # if the provider is disabled) log a terse breadcrumb pointing
            # to the earlier detail. Before this the 200-char skip
            # message spammed the log ~200×/render on any worker where
            # klein-4B, SDXL, or an experimental provider was
            # unavailable.
            if provider_name not in _SKIP_REASON_LOGGED:
                _SKIP_REASON_LOGGED.add(provider_name)
                log.info(f"  [ai-{slot+1}] {provider_name}: skipped ({reason})")
            else:
                log.info(f"  [ai-{slot+1}] {provider_name}: skipped (see earlier log)")
            continue
        log.info(f"  [ai-{slot+1}] {provider_name}: trying ({ai_attempts} attempts)")
        for trial in range(ai_attempts):
            _rs.check_cancel()
            # DIRECTED NICHES KEEP THEIR OWN PROMPT.
            #
            # craft_image_prompt rewrites the shot from scratch with an
            # LLM. For a niche whose shots were composed deliberately —
            # a beat sheet that names the character, the camera and the
            # framing — that discards the direction entirely.
            #
            # Measured, on a wordless render whose beats were correct:
            # the rewriter produced "a hunched figure with matted dark
            # hair", "a weathered lighthouse keeper in a wool coat" and
            # "a tan mixed-breed dog" for three shots of the SAME tin
            # robot, set in a 1920s farmhouse and a 1970s basement. The
            # beat sheet was intact; everything downstream of it was
            # invented.
            #
            # So a niche that supplies its own composed prompt keeps it.
            # Everything else still gets the rewriter, which is genuinely
            # useful when the input is a bare narration sentence.
            if _directed_prompt(channel) and ai_prompt:
                # Keep the composition, but STILL APPLY THE STYLE.
                #
                # craft_image_prompt was doing two jobs: rewriting the
                # shot (which destroys direction) and injecting the
                # niche's look (which is essential). Skipping it threw
                # both away, and a narrated cozy render came back as
                # PHOTOREALISTIC footage of elderly people — correct
                # composition, correct story, entirely the wrong medium.
                #
                # So the style is appended here explicitly. Belt and
                # braces on the medium too: a niche that says it is
                # animated must not silently render as live action.
                prompt_to_use = ai_prompt
                _style = _niche_image_style(channel)
                if _style and _style.lower()[:24] not in prompt_to_use.lower():
                    prompt_to_use = f"{prompt_to_use}. {_style}"
                crafted = None
            else:
                crafted = craft_image_prompt(
                    narration_excerpt=premise,
                    visual_description=visual,
                    channel=channel,
                    # Offset per provider so each gets a distinct seed pool.
                    attempt=trial + (slot * 100),
                    period=period,
                    tone_override=tone_override,
                    language=language,
                )
                prompt_to_use = crafted or ai_prompt
            # Log what is ACTUALLY SENT. This printed
            # `(crafted or ai_prompt)` — the prompt BEFORE the style
            # tail is applied — which made a style-injection bug
            # undiagnosable from the log: the render came back
            # photorealistic and the log showed a prompt that could
            # not explain it either way.
            log.info(f"    {provider_name} prompt (try {trial+1}) [{len(prompt_to_use)} ch]: "
                     f"{prompt_to_use[:110]}"
                     f"{' ... TAIL: ' + prompt_to_use[-70:] if len(prompt_to_use) > 180 else ''}")
            # Character anchor: only Agnes supports image-to-image, so
            # only it takes the reference. Everything else keeps the
            # signature it always had.
            # The anchor is applied SELECTIVELY, not to every shot.
            #
            # Image-to-image reproduces the reference's pose and framing,
            # not just its identity. Anchoring all seven shots of a film
            # to one still produced seven near-identical medium frontal
            # portraits — a character turnaround rather than a film, with
            # every camera instruction (extreme wide, macro, overhead,
            # silhouette) silently overridden.
            #
            # So the anchor is skipped on shots where framing carries the
            # meaning and identity is barely legible anyway: a wide where
            # the character is a speck, a macro of an eye or a pair of
            # hands, a backlit silhouette. Those shots keep identity via
            # the written description instead, which is enough at that
            # scale.
            _use_ref = bool(_cast_ref) and not _framing_over_identity(shot)
            if provider_name == "agnes" and _use_ref:
                path, seed = fn(prompt_to_use, output_dir, trial,
                                negative_prompt, ref_image_path=_cast_ref)
            else:
                path, seed = fn(prompt_to_use, output_dir, trial, negative_prompt)
            if not path:
                continue
            # First image of a character becomes its anchor. setdefault
            # inside the store means a later shot never overwrites it,
            # so every appearance references the same frame rather than
            # drifting one hop at a time.
            if provider_name == "agnes" and not _cast_ref and not _framing_over_identity(shot):
                _cast_anchor_put(shot.get("cast_names") or [], path)
            tag = f"{provider_name}:{seed}"
            if judge_on and threshold >= 0:
                # Only pay the vision-judge round-trip when threshold
                # is real (>=0). On the AI-fallback path we set
                # threshold=-1 above and take the first successful gen
                # without judging — the judge burns 30-90s per call and
                # was rejecting every SDXL image with score=0 live.
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


# Per-channel footage modes.
#
# Motion is opt-in per channel rather than a global switch because the
# providers behind it are rate-limited and uneven: Agnes has generation
# quota, and the Internet Archive only sometimes has on-topic footage.
# Rolling it to every channel at once would spend that budget on
# channels the operator has not evaluated yet.
#
#   stills    AI images only. No generated clips, no archive footage.
#   standard  DEFAULT. What every channel did before real footage
#             existed: generated clips for the opening shots, stills
#             for the rest. Chosen as the default so enabling nothing
#             changes nothing.
#   motion    standard PLUS real public-domain archive footage, and
#             more shots eligible for motion.
#   full      EVERY shot is a generated clip. A 30s video is 6x5s of
#             real motion end to end. Costs 6 Agnes video generations
#             per render, so it is the most expensive mode by far —
#             which is exactly why it is opt-in per channel.
FOOTAGE_MODES = ("stills", "standard", "motion", "full")
DEFAULT_FOOTAGE_MODE = "standard"


def _normalise_footage_mode(mode) -> str:
    m = str(mode or "").strip().lower()
    return m if m in FOOTAGE_MODES else DEFAULT_FOOTAGE_MODE


def _motion_budget(mode: str, total_shots: int = 0) -> int:
    """How many opening shots may use motion, for this mode."""
    if mode == "stills":
        return 0
    if mode in ("motion", "full"):
        # EVERY shot. "motion" used to mean 4 of 6, with "full" as a
        # separate mode for all of them — a distinction that only made
        # sense from the inside. Setting a channel to motion should
        # produce a video made of motion, not a mix where a third of
        # the shots are quietly stills.
        #
        # "full" is kept as an accepted value so any channel already set
        # to it keeps working, but it now behaves identically.
        return max(1, int(total_shots or 6))
    base = _agnes_video_shots()
    if mode == "motion":
        # Motion channels get a wider window, since that is the whole
        # point of putting a channel in this mode.
        try:
            return max(base, int(os.getenv("MOTION_MODE_SHOTS", "4")))
        except Exception:
            return max(base, 4)
    return base


def fetch_shots(shots, output_dir, channel="horror", preset_sources=None,
                tone_override: str = "", language: str = "",
                footage_mode: str = DEFAULT_FOOTAGE_MODE):
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
    # Drop the previous render's character anchors before this one
    # starts, or a worker that stays up would reference the last
    # video's protagonist in this video's shots.
    reset_cast_anchors()
    reset_degraded()
    used_ids = set(F._load_used_clips())
    presets = list(preset_sources or [])
    total = max(1, len(shots))

    # Per-channel footage mode. Unknown/blank falls back to the
    # pre-existing behaviour, so a channel that has never been
    # configured renders exactly as it did before this setting existed.
    _mode = _normalise_footage_mode(footage_mode)
    # Reference portraits BEFORE any shot renders, so the very first
    # appearance already matches the sheet rather than defining it.
    if _mode != "stills":
        try:
            _n = build_cast_sheet(shots, output_dir, channel=channel)
            if _n:
                log.info(f"cast-sheet: {_n} character reference(s) ready")
        except Exception as _e:
            log.warning(f"cast-sheet skipped: {_e!r}")
    log.info(f"footage mode: {_mode} (motion budget: {_motion_budget(_mode, total)} of {total} shot(s))")

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
            src = None
            # Real motion for the opening shots, when enabled. Shorts
            # retention is decided in the first seconds, so a generated
            # clip earns more there than anywhere else in the video —
            # and capping it keeps the ~90 s/clip cost bounded instead
            # of adding half an hour to every render.
            if idx < _motion_budget(_mode, total):
                if _agnes_key():
                    # Same key bug as the archive path had: the
                    # storyboard emits visual_description / ai_prompt /
                    # search_query, never "visual"/"prompt"/"description".
                    # _vp was therefore ALWAYS empty and
                    # _agnes_video_generate was never once called in
                    # production — the motion slot looked configured and
                    # silently produced stills.
                    #
                    # ai_prompt first here: it is the fully-written
                    # diffusion prompt, which is what a generative video
                    # model wants (the opposite of the archive path,
                    # which wants the short search phrase).
                    _vp = (shot.get("ai_prompt") or shot.get("visual_description")
                           or shot.get("search_query") or "")
                    # Per-niche motion direction. Highest-impact
                    # preset field: naming a fast action and a
                    # working camera doubled measured motion.
                    _mh = _motion_hint(channel)
                    if _mh:
                        _vp = f"{_vp}. {_mh}"
                    if _vp:
                        # Generate to the shot's real length. The default
                        # was a fixed 5s regardless of the shot, so a 3s
                        # shot wasted generation and an 8s shot had to be
                        # stretched or frozen to cover the gap.
                        try:
                            _dur = float(shot.get("end", 0)) - float(shot.get("start", 0))
                        except (TypeError, ValueError):
                            _dur = 0.0
                        # Drive the clip from this character's reference
                        # portrait when we have one. Motion mode now
                        # covers every shot, so text-to-video would
                        # re-invent the person on each of the six —
                        # which is precisely the drift the cast sheet
                        # exists to stop.
                        # Animate THIS SHOT'S OWN frame, not the cast
                        # portrait.
                        #
                        # image-to-video uses the supplied image as
                        # FRAME 1. Passing the character sheet therefore
                        # opened every single clip on a studio
                        # head-and-shoulders portrait against a plain
                        # background — visible in the output and plainly
                        # wrong. The portrait is a likeness reference,
                        # never a shot.
                        #
                        # Right order: render the shot's own still first
                        # (find_image_for_shot already applies the cast
                        # anchor, so the face is already consistent),
                        # then animate that. Frame 1 becomes the correct
                        # opening image for the shot AND the character
                        # still matches, which is what we were actually
                        # trying to achieve.
                        with used_lock:
                            _isnap = set(used_ids)
                        _still = find_image_for_shot(
                            shot, output_dir, _isnap, channel=channel,
                            tone_override=tone_override, language=language)
                        with used_lock:
                            used_ids.update(_isnap)
                        _init = ""
                        _sp = (_still or {}).get("path") or ""
                        if _sp and os.path.exists(_sp):
                            try:
                                import base64 as _b64
                                with open(_sp, "rb") as _rf:
                                    _init = ("data:image/jpeg;base64,"
                                             + _b64.b64encode(_rf.read()).decode("ascii"))
                            except Exception as _re:
                                log.warning(f"agnes-video: shot still unreadable: {_re}")
                        # QUALITY GATE. Generate, judge, regenerate.
                        #
                        # The judging happens here rather than after the
                        # whole render because this is the only point
                        # where a bad clip can still be replaced — once
                        # the montage is concatenated the choice is
                        # "ship it or throw away the entire video".
                        _tries = _clip_qc_tries()
                        _best, _best_score, _last_verdict = None, -2, {}
                        for _attempt in range(1, _tries + 1):
                            _cand = _agnes_video_generate(
                                _vp, output_dir, idx,
                                seconds=_dur if _dur > 0 else 5.0,
                                init_image_url=_init)
                            if _cand is None:
                                break
                            _v = _qc_clip(_cand.get("path"), shot, channel=channel)
                            # Rank by vision score, falling back to
                            # "it at least moved" when vision is
                            # unavailable, so the best of N is kept
                            # even when every one of them failed.
                            _score = _v.get("vision", -1)
                            if _score < 0:
                                _score = 0 if _v.get("ok") else -1
                            if _score > _best_score:
                                _best, _best_score, _last_verdict = _cand, _score, _v
                            if _v.get("ok"):
                                log.info(
                                    "shot %d clip passed QC on attempt %d "
                                    "(motion=%s delta=%.1f vision=%s)",
                                    idx + 1, _attempt, _v.get("motion"),
                                    _v.get("mean_diff", -1), _v.get("vision"))
                                break
                            log.warning(
                                "shot %d clip failed QC on attempt %d/%d: %s",
                                idx + 1, _attempt, _tries, _v.get("reason"))
                        src = _best
                        if src is not None and not _last_verdict.get("ok", True):
                            # Best effort: keep the least-bad clip and
                            # record WHY, so the run is flagged degraded
                            # in the dashboard instead of quietly
                            # shipping as if it were clean.
                            src["qc_failed"] = True
                            src["qc_reason"] = str(_last_verdict.get("reason") or "")
                            _register_degraded(idx, _last_verdict)
                        # A STILL IS NOT AN ACCEPTABLE OUTCOME for a
                        # motion-required niche.
                        #
                        # This used to substitute the seed image when the
                        # video model failed, on the reasoning that a
                        # still beats losing the shot. For a niche whose
                        # entire premise is "no still images, every shot
                        # is a real motion clip", that reasoning inverts:
                        # a single frozen shot is the one defect a viewer
                        # notices immediately, and it shipped silently
                        # because the fallback looked like resilience.
                        #
                        # Observed: one Agnes video task exceeded the
                        # 180s poll window while the queue was full, and
                        # the shot became a photograph in a film that
                        # promises none.
                        #
                        # So motion-required niches keep trying, and if
                        # they still cannot get a clip the shot is left
                        # EMPTY and the run is marked degraded — a
                        # missing shot is visible and fixable, a frozen
                        # one is neither.
                        if src is None and _still:
                            if _motion_required(channel):
                                log.error("shot %d: NO CLIP after %d attempt(s) and this "
                                          "niche forbids stills — leaving the shot empty",
                                          idx + 1, _tries)
                                _register_degraded(idx, {
                                    "reason": f"no motion clip after {_tries} attempts; "
                                              f"stills are not permitted for this niche"})
                            else:
                                log.warning("shot %d: no usable clip after %d attempt(s) — "
                                            "falling back to the still", idx + 1, _tries)
                                _register_degraded(idx, {"reason": "no clip generated; used a still"})
                                src = _still
                # Real archive footage — ONLY for channels explicitly
                # put in motion mode. Agnes has generation quota and
                # the Archive's coverage is uneven, so this stays
                # opt-in until the operator has judged the result on a
                # channel they chose.
                if src is None and _mode in ("motion", "full") and _archive_clips_enabled():
                    with used_lock:
                        _snap = set(used_ids)
                    src = _archive_clip_for_shot(shot, output_dir, idx, _snap)
                    with used_lock:
                        used_ids.update(_snap)
                if src is None and not _motion_required(channel):
                    log.info(f"Shot {idx+1}: no motion source, using a still instead")
            # SECOND still-fallback gate. The first one lives inside the
            # motion branch above and refuses to substitute a still for a
            # failed clip. This one is the generic "no source yet" path,
            # and it was still handing back a photograph afterwards —
            # observed live as two consecutive log lines:
            #
            #   shot 2: NO CLIP ... this niche forbids stills
            #   Shot 2: no motion source, using a still instead
            #
            # A guarantee enforced in one place and undone in the next is
            # worse than no guarantee, because the log says it held.
            if src is None and _motion_required(channel):
                log.error("Shot %d: no motion clip and stills are forbidden for this "
                          "niche — shot left EMPTY", idx + 1)
                _register_degraded(idx, {"reason": "no motion clip; stills not permitted"})
            elif src is None:
                # Snapshot used_ids under lock so the provider sees a
                # consistent view; merge new additions back under lock.
                with used_lock:
                    snap = set(used_ids)
                src = find_image_for_shot(shot, output_dir, snap, channel=channel,
                                          tone_override=tone_override, language=language)
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
            or ["local_flux2_klein", "huggingface", "local_sdxl", "pollinations"]
        )
        _ig_enabled = (load_settings().get("image_gen") or {}).get("enabled") or {}
        # Pre-warm klein-4B on Kaggle T4×2 if enabled — same rationale as
        # SDXL pre-warm: first-shot load is ~30-60s including model
        # download, and we don't want any of the parallel shot workers
        # idle-waiting on the load lock during their attempt budget.
        # Cheap no-op on Colab/Oracle (flux2_supported=False).
        if "local_flux2_klein" in _priority_head and _ig_enabled.get("local_flux2_klein", True):
            try:
                from modules import gpu_topology as _gt_f
                if _gt_f.flux2_supported:
                    log.info(
                        "shot fetch pre-warm: loading local_flux2_klein "
                        "via device_map=balanced (blocks pool start)"
                    )
                    _local_flux2_klein_load()
            except Exception as _fe:
                log.debug(f"local_flux2_klein pre-warm skipped: {_fe}")
        # Legacy SDXL pre-warm — keep for the fallback path when
        # klein-4B is disabled or broken.
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
            # Bail immediately on cancel — otherwise as_completed()
            # blocks on the ThreadPoolExecutor's context exit, which
            # waits for every outstanding shot to finish (up to a full
            # minute per shot). Cancel appeared frozen for the user
            # even though the flag was set.
            if run_state.cancellation_requested():
                for _f in futures:
                    _f.cancel()
                ex.shutdown(wait=False, cancel_futures=True)
                raise run_state.Cancelled("shot fetch cancelled")
            try:
                idx, src = fut.result()
            except run_state.Cancelled:
                # A worker thread saw check_cancel() — propagate up so
                # the whole render unwinds instead of continuing to
                # collect partial results from other threads.
                ex.shutdown(wait=False, cancel_futures=True)
                raise
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
