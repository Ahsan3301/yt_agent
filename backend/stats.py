"""
stats.py — Real-time machine + GPU stats for the dashboard monitor.

Exposed via GET /api/stats. The dashboard polls each registered backend
on its own timer so we don't need a central aggregator — each backend
reports its own numbers and the UI fans them out.

CPU/RAM/disk come from psutil. GPU stats come from a single
`nvidia-smi --query-gpu=...` subprocess call (cached for 1s so a fast
poll doesn't fork a process per request). On HF Space CPU containers
nvidia-smi is absent and gpu == None — UI shows the gauge greyed out.
"""
from __future__ import annotations
import os
import time
import shutil
import logging
import subprocess
import threading

log = logging.getLogger(__name__)

_BOOT_AT = time.time()
_gpu_cache = {"at": 0.0, "value": None}
_gpu_lock = threading.Lock()


def _gpu_probe() -> dict | None:
    """One nvidia-smi call returning utilization + VRAM. None if no GPU."""
    if not shutil.which("nvidia-smi"):
        return None
    try:
        r = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        )
        if r.returncode != 0:
            return None
        line = (r.stdout or "").strip().splitlines()[0]
        # "Tesla T4, 12, 234, 15360, 38"
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            return None
        return {
            "name":         parts[0],
            "util_percent": int(float(parts[1])),
            "mem_used_mb":  int(float(parts[2])),
            "mem_total_mb": int(float(parts[3])),
            "mem_percent":  round(float(parts[2]) / max(1.0, float(parts[3])) * 100, 1),
            "temp_c":       int(float(parts[4])) if len(parts) > 4 else None,
        }
    except Exception as e:
        log.debug(f"gpu probe failed: {e}")
        return None


def _gpu_cached() -> dict | None:
    """nvidia-smi takes ~250ms — cache for 1s so 2s polls don't queue."""
    with _gpu_lock:
        if time.time() - _gpu_cache["at"] < 1.0:
            return _gpu_cache["value"]
    v = _gpu_probe()
    with _gpu_lock:
        _gpu_cache["at"] = time.time()
        _gpu_cache["value"] = v
    return v


def collect() -> dict:
    """Snapshot of this backend's resource use right now."""
    out = {
        "uptime_seconds": int(time.time() - _BOOT_AT),
        "instance_id":    None,
        "instance_tier":  None,
        "instance_label": None,
        "public_url":     None,
        "now":            time.time(),
    }
    # Pull identity from registry without taking a hard dep.
    try:
        from backend import registry
        out["instance_id"]    = registry.INSTANCE_ID
        out["instance_tier"]  = registry.INSTANCE_TIER
        out["instance_label"] = registry.INSTANCE_LABEL or None
        out["public_url"]     = registry.public_url() or None
    except Exception:
        pass

    # Current job, if any.
    try:
        from backend import jobs
        active = jobs._active_job_id  # type: ignore[attr-defined]
        out["active_job_id"] = active
        out["queue_depth"]   = jobs.queue_depth()
        out["busy"]          = jobs.is_busy()
        if active:
            j = jobs.get(active)
            if j:
                out["active_job"] = {
                    "id":          j.get("id"),
                    "run_id":      j.get("run_id"),
                    "channel":     j.get("channel"),
                    "percent":     j.get("percent"),
                    "current_step": j.get("current_step"),
                    "current_step_label": j.get("current_step_label"),
                    "started_at":  j.get("started_at"),
                }
    except Exception as e:
        log.debug(f"jobs stat: {e}")
        out["queue_depth"] = 0
        out["busy"] = False

    # CPU / RAM / disk via psutil.
    try:
        import psutil
        # Non-blocking CPU: returns the percent since the LAST call. The
        # very first call returns 0; the dashboard polls every 2s after
        # which it stabilises.
        out["cpu_percent"] = psutil.cpu_percent(interval=None)
        out["cpu_count"]   = psutil.cpu_count(logical=True) or 0

        vm = psutil.virtual_memory()
        out["mem_used_mb"]  = int(vm.used / (1024 * 1024))
        out["mem_total_mb"] = int(vm.total / (1024 * 1024))
        out["mem_percent"]  = round(vm.percent, 1)

        # Use the disk holding our cwd — that's where output/ lives.
        du = psutil.disk_usage(os.getcwd())
        out["disk_used_gb"]  = round(du.used / (1024 ** 3), 2)
        out["disk_total_gb"] = round(du.total / (1024 ** 3), 2)
        out["disk_percent"]  = round(du.percent, 1)

        # Load average where available (linux/mac).
        try:
            la = os.getloadavg()
            out["load_avg"] = [round(la[0], 2), round(la[1], 2), round(la[2], 2)]
        except (AttributeError, OSError):
            pass
    except Exception as e:
        log.warning(f"psutil stats failed: {e}")

    out["gpu"] = _gpu_cached()

    # Storage tier hints.
    try:
        from backend import storage
        out["storage"] = storage.usage_summary()
    except Exception:
        pass

    return out
