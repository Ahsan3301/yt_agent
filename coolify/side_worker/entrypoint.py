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

    # Hot-reload keys + settings from PB every render. Same worker, same
    # container — operator changes to /keys or /settings must land on the
    # NEXT render without a container restart. keys_sync writes to
    # os.environ; settings_sync writes to the local settings.json that
    # modules.config.load_settings() reads.
    try:
        keys_sync.pull_into_env(override=True)
    except Exception as e:
        log.warning(f"keys_sync failed: {e}")
    try:
        from backend import settings_sync as _settings_sync
        _settings_sync.pull_into_local()
    except Exception as e:
        log.warning(f"settings_sync failed: {e}")

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

                # Also poll the PB job doc every ~2s so we notice if the
                # operator hits Cancel — request_cancel() propagates
                # into every check_cancel() call scattered through the
                # pipeline, which raises Cancelled and aborts cleanly.
                # Without this the side-worker was rendering a ghost
                # for the full pipeline duration, blocking the queue.
                def _read_pb_job_status(jid: str) -> str:
                    """Return current PB status for this job. Empty on error."""
                    try:
                        import requests as _rq
                        _pb = os.getenv("PB_URL_INTERNAL") or "http://pocketbase:8090"
                        _em = os.getenv("POCKETBASE_ADMIN_EMAIL")
                        _pw = os.getenv("POCKETBASE_ADMIN_PASSWORD")
                        if not (_em and _pw):
                            return ""
                        _tok = (_rq.post(
                            f"{_pb}/api/collections/_superusers/auth-with-password",
                            json={"identity": _em, "password": _pw}, timeout=4,
                        ).json() or {}).get("token")
                        if not _tok:
                            return ""
                        import hashlib as _h, base64 as _b64
                        raw = jid
                        if not (len(raw) == 15 and raw.isalnum() and raw.islower()):
                            _hs = _h.sha256(raw.encode()).digest()
                            raw = "".join(c for c in _b64.b64encode(_hs).decode("ascii").lower() if c.isalnum())[:15]
                        _r = _rq.get(
                            f"{_pb}/api/collections/jobs/records/{raw}",
                            headers={"Authorization": _tok}, timeout=4,
                        )
                        if _r.status_code != 200:
                            return ""
                        return str((_r.json() or {}).get("status") or "")
                    except Exception:
                        return ""

                def _bridge():
                    last = {"percent": -1, "step": None, "run_id": None}
                    last_status_poll = 0.0
                    STATUS_POLL_INTERVAL = 2.0
                    # Snapshot the run_id we inherit from the previous
                    # render (may be the finished job A's if this is the
                    # second job in a queue burst). We ignore any state
                    # tied to this inherited run_id — including its
                    # status="complete" — and only start honouring
                    # terminal signals once run_state has been reset
                    # by THIS render's run_state.start() call.
                    initial_snapshot = run_state.read() or {}
                    inherited_run_id = str(initial_snapshot.get("run_id") or "")
                    saw_pipeline_start = False   # true once we see run_id CHANGE from inherited
                    while not _stop.is_set():
                        try:
                            s = run_state.read() or {}
                            new_run_id = s.get("run_id") or ""

                            # Detect pipeline start: the new render's
                            # run_state.start() writes a DIFFERENT run_id
                            # than what we inherited. Only from this
                            # moment on is a terminal status in run_state
                            # actually about THIS render.
                            if new_run_id and new_run_id != inherited_run_id:
                                saw_pipeline_start = True

                            if new_run_id and new_run_id != last["run_id"]:
                                last["run_id"] = new_run_id
                                _update_job(job_id, {"run_id": new_run_id})
                                try: _logbuf.attach_run(new_run_id)
                                except Exception: pass

                            pct = int(s.get("percent") or 0)
                            step = s.get("current_step") or ""
                            label = s.get("current_step_label") or ""
                            if pct != last["percent"] or step != last["step"]:
                                last["percent"] = pct
                                last["step"] = step
                                # Only mirror progress to PB once we're
                                # inside THIS render — otherwise we'd
                                # publish inherited pct=100 from the
                                # previous run.
                                if saw_pipeline_start:
                                    _update_job(job_id, {
                                        "percent": pct,
                                        "current_step": step,
                                        "current_step_label": label,
                                    })

                            # Terminal-status early exit — only trusted
                            # after we've seen a genuine pipeline start.
                            if saw_pipeline_start and s.get("status") in ("complete", "failed"):
                                return

                            # Cancel propagation — poll PB every 2s.
                            # This branch runs REGARDLESS of pipeline
                            # start state, because we want to honour a
                            # cancel even during the awkward split-second
                            # window between claim and run_state.start().
                            _tnow = time.time()
                            if _tnow - last_status_poll > STATUS_POLL_INTERVAL:
                                last_status_poll = _tnow
                                pb_status = _read_pb_job_status(job_id)
                                if pb_status == "cancelled":
                                    log.warning(
                                        f"progress bridge: PB job {job_id} marked "
                                        f"cancelled — signalling pipeline abort"
                                    )
                                    try: run_state.request_cancel()
                                    except Exception as _rce:
                                        log.warning(f"request_cancel failed: {_rce}")
                                    return
                        except Exception as _bre:
                            # Elevated from log.debug to log.warning: silent
                            # exceptions here were the reason the last cancel
                            # bug went undetected for a full render.
                            log.warning(f"progress bridge tick failed: {_bre}")
                        _stop.wait(0.4)

                _bridge_thread = _threading.Thread(target=_bridge, daemon=True)
                _bridge_thread.start()

                # req_id tag on every log emit so /queue/[id] filters
                # match the correct run's logs.
                try:
                    _logbuf.set_req_id(str(job.get("req_id") or job_id)[:12])
                except Exception:
                    pass

                # Apply per-channel Cloudflare creds (own / global / off)
                # to os.environ for this render only. Matches the shim
                # in backend/jobs.py so both worker paths behave the same.
                from backend import channel_cf as _cf
                from backend import channel_llm as _cllm
                _cf_snap = _cf.apply_from_job(job)
                _llm_snap = _cllm.apply_from_job(job)

                # Kwarg names mirror backend/jobs.py::_run_pipeline_job.
                try:
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
                finally:
                    _cf.restore_env(_cf_snap)
                    _cllm.restore_env(_llm_snap)
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
                # NOTE: run_state lives at modules/run_state.py, not
                # backend/ — the earlier `from backend import run_state`
                # tripped ImportError silently for every render, so
                # this cleanup never actually ran on Oracle and assets
                # accumulated on the VPS.
                try:
                    from modules import run_state as _run_state_pkg
                    from backend import housekeeping
                    _final = _run_state_pkg.read() or {}
                    # `res` is the summary dict returned by main.run_pipeline.
                    # summary["published"]["youtube_url"] is where the
                    # uploader stashes the publish URL — run_state never
                    # gets that key, so the earlier lookup of _final.published
                    # was ALWAYS None, which is why housekeeping never
                    # ran on Oracle even after a successful publish.
                    _summary = res if isinstance(res, dict) else {}
                    _work_dir = f"output/videos/{_final.get('run_id') or _summary.get('run_id') or job.get('run_id') or ''}"
                    _pub_yt = (
                        ((_summary.get("published") or {}).get("youtube_url") or "").strip()
                        or ((_final.get("published") or {}).get("youtube_url") or "").strip()
                    )
                    _hk = housekeeping.finalize_run(
                        _work_dir,
                        str(_final.get("run_id") or _summary.get("run_id") or job.get("run_id") or ""),
                        published=bool(_pub_yt),
                        dry_run=bool(job.get("dry_run", False)),
                        local_video_path=str(_summary.get("final_video") or _final.get("video_path") or ""),
                        current_public_url=str(_summary.get("video_url") or _final.get("video_url") or ""),
                    )
                    if _hk.get("cleaned"):
                        log.info(f"housekeeping: freed ~{_hk.get('freed_mb', 0)} MB")
                    elif _hk.get("skipped_reason"):
                        log.info(f"housekeeping skipped: {_hk['skipped_reason']}")
                except Exception as _e:
                    log.warning(f"housekeeping failed: {_e}")
    except Exception as e:
        # Distinguish user-cancel from real crash so the dashboard
        # doesn't get Discord-spammed and the job doesn't show a red
        # "failed" chip for a run the operator killed on purpose.
        try:
            from modules import run_state as _rs_check
            _cancelled_flag = _rs_check.cancellation_requested() or isinstance(e, _rs_check.Cancelled)
        except Exception:
            _cancelled_flag = False
        if _cancelled_flag:
            ok, msg = False, "cancelled by user"
        else:
            ok, msg = False, f"dispatch crashed: {e}"
            log.exception(msg)

    # Belt-and-suspenders disk cleanup — finalize_run() above REFUSES
    # to delete on !published, which means every cancelled / failed /
    # crashed render leaked its work_dir forever (SDXL frames, TTS
    # wavs, per-shot mp4s, final_video.mp4 all accumulating). Force
    # it here regardless of terminal state; if finalize_run already
    # ran cleanly on the happy path, this is a no-op.
    if not ok:
        try:
            from modules import run_state as _rs2
            from backend import housekeeping as _hk2
            _rid = (_rs2.read() or {}).get("run_id") or job.get("run_id") or ""
            if _rid:
                _hk2.force_cleanup(f"output/videos/{_rid}", reason="run failed/cancelled")
        except Exception as _e2:
            log.warning(f"force_cleanup failed: {_e2}")

    # Compute the final PB status. A user-cancel is NOT a failure —
    # keeping them separate stops Discord spam + keeps the /reports
    # graphs honest.
    _final_status = "complete" if ok else (
        "cancelled" if msg == "cancelled by user" else "failed"
    )
    _update_job(job_id, {
        "status": _final_status,
        "error": "" if ok else msg,
        "current_step": kind,
        "current_step_label": f"{kind}: {msg[:100]}",
        "percent": 100,
        "finished_at": time.time(),
    })
    log.info(f"job {job_id} done ok={ok} msg={msg[:200]}")

    # Discord alert. Skip on user-cancel — the operator did it on
    # purpose, no need to spam the channel or write to errors/.
    try:
        from backend import notifier
        # Route the alert to the CHANNEL'S webhook, not the global one.
        # Without channel_niche, per-channel webhook lookup is skipped
        # and failures land on the operator's default DISCORD_WEBHOOK_URL
        # regardless of which channel actually failed.
        _ch_niche = str(job.get("channel") or "").strip() or None
        if ok:
            notifier.info(f"✅ {kind} complete (Oracle)", body=msg,
                          channel_niche=_ch_niche)
        elif _final_status == "cancelled":
            pass  # silence — user cancelled deliberately
        else:
            notifier.report_error(err=msg, title=f"❌ {kind} failed (Oracle)",
                                  run_id=job.get("run_id"), req_id=job.get("req_id"),
                                  channel_niche=_ch_niche)
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
