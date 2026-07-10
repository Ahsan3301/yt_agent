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

# Attach the ring-buffer + PB log stream. Without this, the dashboard's
# /queue/[id] LogsPanel shows an empty stream for Oracle renders (the
# Kaggle/Colab workers get this for free via backend.server startup;
# the side-worker skips that FastAPI boot path).
try:
    from backend import logbuf
    logbuf.attach()
except Exception as _e:
    log.warning(f"logbuf.attach failed — dashboard log stream disabled: {_e}")

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
    """Poll for a job. Sends instance_label='oracle' + oracle_password
    so the per-channel claim gate can verify this worker is allowed
    to run a given channel's job."""
    import requests
    try:
        r = requests.post(
            f"{INTERNAL_URL}/api/jobs/claim",
            json={
                "instance_id": INSTANCE_ID,
                "instance_label": "oracle",
                "tier": TIER,
                "oracle_password": os.getenv("ORACLE_UNLOCK_PASSWORD", ""),
            },
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
    """Route a claimed job. Side-jobs go to backend.side_jobs.dispatch;
    render jobs go to main.run_pipeline (CPU-only path — local_sdxl
    skips itself gracefully when torch.cuda.is_available() is False,
    so image gen falls through to pollinations / HF / horde)."""
    from backend import keys_sync
    job_id = str(job.get("id") or "")
    kind = str(job.get("kind") or "render")
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
        if kind in ("publish_youtube", "copy_storage"):
            from backend import side_jobs
            ok, msg = side_jobs.dispatch(job)
        else:
            # Full render on Oracle (CPU-only fallback). Deps may not
            # be installed on the side-worker image — catch ImportError
            # and mark failed with a clear message so the channel drops
            # to the next allowed worker.
            try:
                import main as _main
                from modules import run_state
                from backend import logbuf as _logbuf
            except ImportError as e:
                ok, msg = False, (
                    f"Oracle side-worker missing render deps ({e}). "
                    f"Rebuild coolify/side_worker/Dockerfile with "
                    f"requirements-cpu.txt to enable CPU renders on Oracle."
                )
                log.error(msg)
            else:
                # ── Progress bridge ────────────────────────────────
                # Mirror run_state.read() → PB jobs record every ~400ms
                # so the /queue/[id] Pipeline Progress bar + Monitor
                # step-label advance in real time. Same pattern as
                # backend/jobs.py::_run_pipeline_job::progress_bridge.
                import threading as _threading
                _stop = _threading.Event()

                def _bridge():
                    last = {"percent": -1, "step": None, "run_id": None}
                    while not _stop.is_set():
                        try:
                            s = run_state.read() or {}
                            new_run_id = s.get("run_id") or ""
                            if new_run_id and new_run_id != last["run_id"]:
                                last["run_id"] = new_run_id
                                _update_job(job_id, {"run_id": new_run_id})
                                # Bind logbuf to this run_id so log lines
                                # stream into runs_index/<run_id>/logs
                                # which the LogsPanel subscribes to.
                                try: _logbuf.attach_run(new_run_id)
                                except Exception: pass
                            pct = int(s.get("percent") or 0)
                            step = s.get("current_step") or ""
                            label = s.get("current_step_label") or ""
                            if pct != last["percent"] or step != last["step"]:
                                last["percent"] = pct
                                last["step"] = step
                                _update_job(job_id, {
                                    "percent": pct,
                                    "current_step": step,
                                    "current_step_label": label,
                                })
                            if s.get("status") in ("complete", "failed"):
                                return
                        except Exception as _bre:
                            log.debug(f"progress bridge tick failed: {_bre}")
                        _stop.wait(0.4)

                _bridge_thread = _threading.Thread(target=_bridge, daemon=True)
                _bridge_thread.start()

                # req_id tag on every log emit so /queue/[id] filters
                # match the correct run's logs.
                try:
                    _logbuf.set_req_id(str(job.get("req_id") or job_id)[:12])
                except Exception:
                    pass

                # Kwarg names mirror backend/jobs.py::_run_pipeline_job.
                res = _main.run_pipeline(
                    channel_type=str(job.get("channel") or "").strip(),
                    dry_run=bool(job.get("dry_run", False)),
                    resume_run_id=str(job.get("run_id") or ""),
                    manual_topic=job.get("manual_topic", ""),
                    manual_script=job.get("manual_script", ""),
                    manual_title=job.get("manual_title", ""),
                    manual_images=job.get("manual_images") or [],
                    manual_channel_desc=job.get("manual_channel_desc", ""),
                    web_research=job.get("web_research"),
                    real_events=job.get("real_events"),
                    language=job.get("language"),
                    voice_override=job.get("voice_override"),
                    tone_override=job.get("tone_override"),
                    privacy_override=job.get("privacy_override"),
                    youtube_account_id=job.get("youtube_account_id"),
                )
                ok = bool(res) if isinstance(res, bool) else bool((res or {}).get("ok"))
                msg = "render complete" if ok else "render failed"

                # Stop the progress bridge — pipeline has terminated so
                # no more updates will arrive from run_state.
                _stop.set()
                try: _bridge_thread.join(timeout=2)
                except Exception: pass

                # Post-publish housekeeping — mirror final_video.mp4 to
                # R2 then rmtree the local work_dir. Only fires on a
                # successful non-dry-run render that actually published
                # to YouTube (finalize_run guards on both flags).
                try:
                    from backend import run_state, housekeeping
                    _final = run_state.read() or {}
                    _work_dir = f"output/videos/{_final.get('run_id') or job.get('run_id') or ''}"
                    _pub_yt = ((_final.get("published") or {}).get("youtube_url") or "").strip()
                    _hk = housekeeping.finalize_run(
                        _work_dir,
                        str(_final.get("run_id") or job.get("run_id") or ""),
                        published=bool(_pub_yt),
                        dry_run=bool(job.get("dry_run", False)),
                        local_video_path=str(_final.get("video_path") or ""),
                        current_public_url=str(_final.get("video_url") or ""),
                    )
                    if _hk.get("cleaned"):
                        log.info(f"housekeeping: freed ~{_hk.get('freed_mb', 0)} MB")
                    elif _hk.get("skipped_reason"):
                        log.info(f"housekeeping skipped: {_hk['skipped_reason']}")
                except Exception as _e:
                    log.warning(f"housekeeping failed: {_e}")
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


# Shared state for the background heartbeat thread. handle() updates
# _current_active_job_id when a claim lands / completes so the heartbeat
# carries the right active_job_id even during a long-blocking render.
import threading as _threading
_current_active_job_id = ""
_current_active_lock = _threading.Lock()


def _bg_heartbeat_loop():
    """Fires register() every HEARTBEAT_SEC on its own thread. Kaggle/
    Colab workers get this for free from backend.server's uvicorn loop;
    on the side-worker the main() loop is serial, so a long render
    blocks register() for 30+ minutes and /api/backends deletes the
    row for going 'stale'. This thread keeps the heartbeat alive
    regardless of what handle() is doing."""
    while True:
        try:
            with _current_active_lock:
                aj = _current_active_job_id
            register(aj)
        except Exception as e:
            log.debug(f"bg heartbeat failed: {e}")
        time.sleep(HEARTBEAT_SEC)


def main() -> None:
    global _startup, _current_active_job_id
    _startup = time.time()
    log.info(f"side-worker starting  instance_id={INSTANCE_ID}  tier={TIER}  "
             f"platform={platform.machine()}")
    register()

    # Background heartbeat — runs forever, independent of the render loop.
    _threading.Thread(target=_bg_heartbeat_loop, daemon=True).start()
    log.info(f"heartbeat thread started (interval={HEARTBEAT_SEC}s)")

    while True:
        try:
            job = claim()
            if job:
                jid = str(job.get("id") or "")
                with _current_active_lock:
                    _current_active_job_id = jid
                register(jid)          # immediate beat with active_job_id set
                handle(job)            # blocking — but heartbeat thread keeps beating
                with _current_active_lock:
                    _current_active_job_id = ""
                register("")           # immediate beat freeing active_job_id
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
