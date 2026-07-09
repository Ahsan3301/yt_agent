"""Single source of truth for GPU topology on the worker.

Detected once at import so every consumer (shotfinder, voiceover,
main.py's warm scheduler, backend.registry) sees the same view. Safe
on CPU-only workers — everything degrades to empty lists / None.

The T4x2 Kaggle accelerator gives us two 16 GB Turing GPUs (sm_7.5).
Modern PyTorch wheels dropped sm_6.x kernels, so we gate multi-GPU
mode on cap[0] >= 7 for EVERY visible device — a mixed setup (T4+K80)
would otherwise crash on cuda:1 the first time SDXL touched it.
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

device_ids: list[int] = []
compute_caps: list[tuple[int, int]] = []
gpu_names: list[str] = []
supports_multi_gpu: bool = False
sdxl_ready_devices: list[int] = []
kokoro_device: int | None = None


def _detect() -> None:
    global device_ids, compute_caps, gpu_names, supports_multi_gpu
    global sdxl_ready_devices, kokoro_device
    try:
        import torch
    except Exception as e:
        log.info(f"gpu_topology: torch not importable ({e}); CPU-only")
        return
    try:
        if not torch.cuda.is_available():
            log.info("gpu_topology: no CUDA device visible; CPU-only")
            return
        n = int(torch.cuda.device_count())
    except Exception as e:
        log.warning(f"gpu_topology: torch.cuda probe failed ({e}); CPU-only")
        return
    ids: list[int] = []
    caps: list[tuple[int, int]] = []
    names: list[str] = []
    for i in range(n):
        try:
            cap = torch.cuda.get_device_capability(i)
            name = torch.cuda.get_device_name(i)
        except Exception as e:
            log.warning(f"gpu_topology: probe failed for cuda:{i} ({e})")
            continue
        ids.append(i)
        caps.append((int(cap[0]), int(cap[1])))
        names.append(str(name))
    device_ids = ids
    compute_caps = caps
    gpu_names = names
    sdxl_ready_devices = [i for i, c in zip(ids, caps) if c[0] >= 7]
    # Multi-GPU mode requires ALL visible devices to be sm_7+ so
    # round-robin dispatch doesn't land a shot on a card the pipeline
    # can't run on. A single sm_6 card demotes us to single-GPU mode
    # on the sm_7+ device.
    supports_multi_gpu = len(sdxl_ready_devices) >= 2
    # Kokoro is tiny (~330 MB); pin it to cuda:1 when we have one so
    # it doesn't compete with SDXL warm on cuda:0 during step [3/6].
    # Falls back to cuda:0 if only one GPU is present.
    if supports_multi_gpu:
        kokoro_device = sdxl_ready_devices[1]
    elif sdxl_ready_devices:
        kokoro_device = sdxl_ready_devices[0]
    else:
        kokoro_device = None
    log.info(
        f"gpu_topology: device_count={n}, multi_gpu={supports_multi_gpu}, "
        f"caps={compute_caps}, kokoro_device={kokoro_device}"
    )


_detect()
