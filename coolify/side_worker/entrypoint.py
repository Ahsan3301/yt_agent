"""
Oracle-hosted side-worker — never renders, only executes side-jobs
(publish_youtube / copy_storage) targeted at the dashboard.

Registers as a backend with tier='dashboard' + label='Oracle sidecar'
so the Monitor page shows it. Uses the SAME job protocol as the
Kaggle worker (poll /api/jobs/claim), just with a different tier
filter — jobs whose target_worker is 'dashboard' land here.
"""
from __future__ import annotations
import os
import sys
import time
import logging
import socket
import platform

# Make the repo importable.
sys.path.insert(0, "/app")

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("side_worker")

INSTANCE_ID    = os.getenv("INSTANCE_ID") or f"oracle-{socket.gethostname()[:12]}"
INSTANCE_LABEL = os.getenv("INSTANCE_LABEL") or "Oracle side-worker"
TIER           = "dashboard"
POLL_SEC       = int(os.getenv("SIDE_WORKER_POLL_SEC", "6"))
HEARTBEAT_SEC  = int(os.getenv("SIDE_WORKER_HEARTBEAT_SEC", "20"))

COOLIFY_BASE_URL = os.getenv("COOLIFY_BASE_URL") or os.getenv("PUBLIC_BASE_URL") or ""
# Register + claim endpoints live on the SAME container as this one on
# the internal docker network. Prefer the internal hostname to avoid
# taking a public-DNS round trip.
INTERNAL_URL     = os.getenv("INTERNAL_DASHBOARD_URL") or "http://dashboard:3000"
RENDER_TRIGGER_KEY = os.getenv("RENDER_TRIGGER_KEY") or ""

if not RENDER_TRIGGER_KEY:
    log.error("RENDER_TRIGGER_KEY unset — refusing to start. Set it via Coolify env.")
    sys.exit(1)


def _sample_stats() -> dict:
    """Same shape as backend/registry._sample_stats — Monitor renders
    from these fields. Just cpu/mem/disk (no GPU on Oracle ARM)."""
    out: dict = {
        "cpu_percent": None,
        "mem_percent": None,
        "disk_used_gb": None,
        "disk_total_gb": None,
        "gpu": None,
        "sampled_at": time.time(),
    }
    try:
        import psutil
        out["cpu_percent"] = round(psutil.cpu_percent(interval=None), 1)
        vm = psutil.virtual_memory()
        out["mem_percent"]  = round(vm.percent, 1)
        out["mem_used_gb"]  = round((vm.total - vm.available) / (1024**3), 2)
        out["mem_total_gb"] = round(vm.total / (1024**3), 2)
        du = psutil.disk_usage("/")
        out["disk_used_gb"]  = round(du.used / (1024**3), 1)
        out["disk_total_gb"] = round(du.total / (1024**3), 1)
    except Exception as e:
        log.debug(f"psutil unavailable: {e}")
    return out


def register(active_job_id: str = "") -> None:
    """Heartbeat to /api/workers/register — puts us on the Monitor page."""
    import requests
    payload = {
        "instance_id":  INSTANCE_ID,
        "label":        INSTANCE_LABEL,
        "tier":         TIER,
        "gpu_name":     "",   # Oracle ARM has no GPU
        "status":       "busy" if active_job_id else "available",
        "url":          "",   # outbound-poll model
        "started_at":   _startup,
        "active_job_id": active_job_id or "",
        "stats":        _sample_stats(),
    }
    try:
        r = requests.post(
            f"{INTERNAL_URL}/api/workers/register",
            json=payload,
            headers={"X-API-Key": RENDER_TRIGGER_KEY},
            timeout=10,
        )
        if r.ok:
            d = r.json() or {}
            if d.get("shutdown"):
                log.warning("dashboard requested shutdown; exiting.")
                sys.exit(0)
        else:
            log.warning(f"register HTTP {r.status_code}: {r.text[:200]}")
    except Exception as e:
        log.debug(f"register failed: {e}")


def claim() -> dict | None:
    """Poll for a job. Only jobs with target_worker in ('dashboard',
    INSTANCE_ID, '') will be returned to us (claim route filters)."""
    import requests
    try:
        r = requests.post(
            f"{INTERNAL_URL}/api/jobs/claim",
            json={"instance_id": INSTANCE_ID, "tier": TIER},
            headers={"X-API-Key": RENDER_TRIGGER_KEY},
            timeout=10,
        )
        if r.status_code == 204:
            return None
        if not r.ok:
            log.warning(f"claim HTTP {r.status_code}: {r.text[:200]}")
            return None
        payload = r.json() or {}
        if payload.get("shutdown"):
            log.warning("dashboard requested shutdown via claim; exiting.")
            sys.exit(0)
        return payload.get("job")
    except Exception as e:
        log.debug(f"claim failed: {e}")
        return None


def _update_job(job_id: str, patch: dict) -> None:
    """Direct PB write to update a job — the dashboard REST APIs don't
    expose an atomic job.update, but PB does."""
    import requests
    pb_url = os.getenv("PB_URL_INTERNAL") or "http://pocketbase:8090"
    email  = os.getenv("POCKETBASE_ADMIN_EMAIL")
    pw     = os.getenv("POCKETBASE_ADMIN_PASSWORD")
    if not (email and pw):
        return
    try:
        auth = requests.post(
            f"{pb_url}/api/collections/_superusers/auth-with-password",
            json={"identity": email, "password": pw}, timeout=6,
        ).json()
        tok = auth.get("token") or ""
        if not tok: return
        import hashlib, base64
        # PB doc id: same hash as the wrapper uses.
        raw = job_id
        if not (len(raw) == 15 and raw.isalnum() and raw.islower()):
            h = hashlib.sha256(raw.encode()).digest()
            b64 = base64.b64encode(h).decode("ascii").lower()
            raw = "".join(c for c in b64 if c.isalnum())[:15]
        requests.patch(
            f"{pb_url}/api/collections/jobs/records/{raw}",
            json=patch,
            headers={"Authorization": tok},
            timeout=6,
        )
    except Exception as e:
        log.debug(f"_update_job failed: {e}")


def handle(job: dict) -> None:
    """Route a claimed job to backend.side_jobs.dispatch and write
    the terminal result back to the jobs collection."""
    from backend import side_jobs, keys_sync
    job_id = str(job.get("id") or "")
    kind = str(job.get("kind") or "")
    log.info(f"handling job {job_id} kind={kind} run_id={job.get('run_id')}")

    _update_job(job_id, {
        "status": "running", "started_at": time.time(),
        "current_step": kind, "current_step_label": f"{kind}: running", "percent": 5,
    })

    try:
        keys_sync.pull_into_env(override=True)
    except Exception as e:
        log.warning(f"keys_sync failed: {e}")

    ok, msg = False, "no result"
    try:
        ok, msg = side_jobs.dispatch(job)
    except Exception as e:
        ok, msg = False, f"dispatch crashed: {e}"
        log.exception(msg)

    _update_job(job_id, {
        "status": "complete" if ok else "failed",
        "error": "" if ok else msg,
        "current_step": kind,
        "current_step_label": f"{kind}: {msg[:100]}",
        "percent": 100,
        "finished_at": time.time(),
    })
    log.info(f"job {job_id} done ok={ok} msg={msg[:200]}")

    # Discord alert.
    try:
        from backend import notifier
        if ok:
            notifier.info(f"✅ {kind} complete (Oracle)", body=msg)
        else:
            notifier.report_error(err=msg, title=f"❌ {kind} failed (Oracle)",
                                  run_id=job.get("run_id"), req_id=job.get("req_id"))
    except Exception:
        pass


def main() -> None:
    global _startup
    _startup = time.time()
    log.info(f"side-worker starting  instance_id={INSTANCE_ID}  tier={TIER}  "
             f"platform={platform.machine()}")
    register()
    last_hb = time.time()
    active_job_id = ""
    while True:
        try:
            if time.time() - last_hb > HEARTBEAT_SEC:
                register(active_job_id)
                last_hb = time.time()
            job = claim()
            if job:
                active_job_id = str(job.get("id") or "")
                register(active_job_id)
                handle(job)
                active_job_id = ""
                register("")
                last_hb = time.time()
            else:
                time.sleep(POLL_SEC)
        except KeyboardInterrupt:
            log.info("SIGINT — exiting.")
            return
        except Exception as e:
            log.exception(f"loop error: {e}")
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
