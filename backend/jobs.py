"""
jobs.py — In-memory job queue with a single worker thread.

Why a queue: when the dashboard submits videos faster than the Colab
backend can render them, jobs sit in FIFO order on the SAME backend instead
of spawning new Colab instances. The worker picks them up serially; vision
+ LLM rate limits stay sane.

Each job's progress is mirrored into modules.run_state so the existing
progress-bar code keeps working. The full job record (queued/running/done)
lives in `data/jobs/<job_id>.json` and the in-memory `_jobs` dict.
"""
import os
import json
import time
import uuid
import queue
import logging
import threading
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

JOBS_DIR = Path("data/jobs")
JOBS_DIR.mkdir(parents=True, exist_ok=True)

# ── State ────────────────────────────────────────────────────
_lock = threading.RLock()
_jobs: dict[str, dict[str, Any]] = {}       # job_id → record (in-memory mirror)
_pending: "queue.Queue[str]" = queue.Queue()
_active_job_id: Optional[str] = None
_worker_started = False


def _persist(job: dict[str, Any]):
    """Atomic write of one job record. Mirrors to Firestore so the
    Vercel API gateway can find this job regardless of which backend
    is asked."""
    p = JOBS_DIR / f"{job['id']}.json"
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(job, f, indent=2)
    os.replace(tmp, p)
    # Best-effort Firestore mirror — never fail the local persist on
    # remote failures.
    try:
        from backend import jobs_db, registry
        record = dict(job)
        record.setdefault("backend_instance_id", registry.INSTANCE_ID)
        record.setdefault("backend_url", registry.public_url() or None)
        jobs_db.upsert_job(record)
    except Exception as e:
        log.debug(f"_persist: Firestore mirror skipped ({e})")


def _load_persisted():
    """Hydrate in-memory state on startup from disk + Firestore."""
    # Local files first.
    for p in sorted(JOBS_DIR.glob("*.json")):
        try:
            with open(p, "r", encoding="utf-8") as f:
                job = json.load(f)
            jid = job.get("id")
            if not jid:
                continue
            # Anything marked running on the previous shutdown is now stale.
            if job.get("status") == "running":
                job["status"] = "failed"
                job["error"] = "backend restarted while running"
                job["finished_at"] = job.get("finished_at") or time.time()
                _persist(job)
            _jobs[jid] = job
        except Exception as e:
            log.warning(f"could not load job from {p}: {e}")

    # Firestore mirror: anything that says it's running on THIS
    # instance (from before the restart) gets the same stale-marker
    # treatment so the dashboard's status flips to failed instead of
    # hanging forever on "running".
    try:
        from backend import jobs_db, registry
        for remote in jobs_db.list_for_backend(registry.INSTANCE_ID):
            jid = remote.get("id")
            if not jid or jid in _jobs:
                continue
            if remote.get("status") == "running":
                remote["status"] = "failed"
                remote["error"] = "backend restarted while running"
                remote["finished_at"] = remote.get("finished_at") or time.time()
            _jobs[jid] = remote
            _persist(remote)
    except Exception as e:
        log.debug(f"jobs hydrate from Firestore skipped: {e}")


# ── Public API ───────────────────────────────────────────────
def submit(payload: dict[str, Any]) -> dict[str, Any]:
    """Enqueue a new job. `payload` should have at least `channel` and
    `dry_run`. Returns the new job record.

    Manual-mode params (all optional):
      manual_topic        — seed topic; replaces auto-research's pick.
      manual_script       — full narration; replaces research + script.
      manual_title        — overrides the auto-generated YouTube title.
      manual_images       — list of public URLs to use as shot footage.
      manual_channel_desc — for custom (unknown) channel names: a brief
                            description the channel-config synthesizer
                            can use to build a preset on the fly.
    """
    jid = uuid.uuid4().hex[:12]
    job = {
        "id": jid,
        "status": "queued",
        "channel": payload.get("channel", "horror"),
        "dry_run": bool(payload.get("dry_run", True)),
        "queued_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "percent": 0,
        "current_step": None,
        "current_step_label": None,
        "video_url": None,
        "public_url": None,
        "error": None,
        "run_id": None,            # filled when the run starts (matches output/videos/<run_id>)
        # Manual-mode payload (all default to falsy → standard pipeline).
        "manual_topic":        str(payload.get("manual_topic") or "")[:1000],
        "manual_script":       str(payload.get("manual_script") or "")[:20_000],
        "manual_title":        str(payload.get("manual_title") or "")[:200],
        "manual_images":       list(payload.get("manual_images") or [])[:32],
        "manual_channel_desc": str(payload.get("manual_channel_desc") or "")[:500],
        # tri-state: None = use channel default; True/False = override.
        "web_research":        payload.get("web_research"),
        # Real-events research mode (forces script grounding in
        # documented facts). Tri-state same as web_research.
        "real_events":         payload.get("real_events"),
        # Script language (ISO-2). None = use channel preset default.
        "language":            (str(payload.get("language") or "")[:5].lower() or None),
        # Voice override (one of the niche's voices_by_lang entries).
        "voice_override":      str(payload.get("voice_override") or "")[:80] or None,
        # YouTube account id (multi-channel mode). None falls back to
        # the legacy single api_keys/YOUTUBE_REFRESH_TOKEN credential.
        "youtube_account_id":  str(payload.get("youtube_account_id") or "")[:80] or None,
    }
    with _lock:
        _jobs[jid] = job
        _persist(job)
        _pending.put(jid)
    _ensure_worker()
    log.info(f"job queued | id={jid} channel={job['channel']} dry={job['dry_run']} "
             f"(queue depth={_pending.qsize()})")
    return job


def adopt_remote(remote_job: dict[str, Any]) -> bool:
    """Pick up a job that was queued via the Vercel gateway and just
    claimed by registry.py's heartbeat loop. Identical to submit() but
    skips the Firestore upsert (we just won the transaction that set
    backend_instance_id; another upsert would race nothing useful)."""
    jid = remote_job.get("id")
    if not jid:
        return False
    job = {
        "id": jid,
        "status": "queued",
        "channel": remote_job.get("channel", "horror"),
        "dry_run": bool(remote_job.get("dry_run", True)),
        "queued_at": remote_job.get("queued_at") or time.time(),
        "started_at": None,
        "finished_at": None,
        "percent": 0,
        "current_step": None,
        "current_step_label": None,
        "video_url": None,
        "public_url": None,
        "error": None,
        "run_id": None,
        # Manual-mode payload propagated from the Vercel-queued job doc.
        "manual_topic":        str(remote_job.get("manual_topic") or "")[:1000],
        "manual_script":       str(remote_job.get("manual_script") or "")[:20_000],
        "manual_title":        str(remote_job.get("manual_title") or "")[:200],
        "manual_images":       list(remote_job.get("manual_images") or [])[:32],
        "manual_channel_desc": str(remote_job.get("manual_channel_desc") or "")[:500],
        "web_research":        remote_job.get("web_research"),
        "real_events":         remote_job.get("real_events"),
        "language":            (str(remote_job.get("language") or "")[:5].lower() or None),
        "voice_override":      str(remote_job.get("voice_override") or "")[:80] or None,
        "youtube_account_id":  str(remote_job.get("youtube_account_id") or "")[:80] or None,
    }
    with _lock:
        if jid in _jobs:
            return False
        _jobs[jid] = job
        _persist(job)
        _pending.put(jid)
    _ensure_worker()
    log.info(f"job claimed from Firestore queue | id={jid} channel={job['channel']}")
    return True


def get(job_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        return _jobs.get(job_id)


def list_all(limit: int = 50) -> list[dict[str, Any]]:
    """Most-recent first by queued_at."""
    with _lock:
        items = sorted(_jobs.values(),
                       key=lambda j: j.get("queued_at", 0), reverse=True)
    return items[:limit]


def cancel(job_id: str) -> bool:
    """Cancel a job. Three paths:

      * Queued (not started): drop status to 'cancelled' immediately.
      * Running: signal the pipeline via run_state.request_cancel() AND
        terminate the active ffmpeg subprocess so the encode stops
        within a second. The worker thread sees Cancelled at the next
        step seam and exits cleanly.
      * Terminal already: no-op, return False.
    """
    with _lock:
        job = _jobs.get(job_id)
        if not job or job["status"] in ("complete", "failed", "cancelled"):
            return False
        is_running = (job["status"] == "running")
        job["status"] = "cancelled"
        job["finished_at"] = time.time()
        job["error"] = "cancelled by user"
        _persist(job)

    if is_running:
        # 1) Set the cancel flag in run_state so the pipeline's check_cancel()
        #    seams raise Cancelled at the next safe boundary.
        try:
            from modules import run_state
            run_state.request_cancel()
        except Exception as e:
            log.warning(f"cancel: request_cancel failed: {e}")
        # 2) Kill the currently-running ffmpeg so we don't wait for the
        #    encode to finish before the seam check fires.
        try:
            from modules import editor
            editor.terminate_active()
        except Exception as e:
            log.warning(f"cancel: terminate_active failed: {e}")
    return True


def is_busy() -> bool:
    """True if any job is currently running."""
    return _active_job_id is not None


def queue_depth() -> int:
    return _pending.qsize() + (1 if _active_job_id else 0)


def update_progress(percent: float, step: str, label: str):
    """Called from the pipeline as it advances. Mirrors into job record."""
    global _active_job_id
    with _lock:
        if _active_job_id and _active_job_id in _jobs:
            j = _jobs[_active_job_id]
            j["percent"] = int(percent)
            j["current_step"] = step
            j["current_step_label"] = label
            _persist(j)


# ── Worker ───────────────────────────────────────────────────
def _ensure_worker():
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    t = threading.Thread(target=_worker_loop, daemon=True, name="yt-agent-worker")
    t.start()
    log.info("job worker started")


def _worker_loop():
    global _active_job_id
    while True:
        try:
            jid = _pending.get()
        except Exception:
            time.sleep(0.5)
            continue

        with _lock:
            job = _jobs.get(jid)
            if not job:
                continue
            if job["status"] == "cancelled":
                # user cancelled before it could run; skip silently
                continue
            job["status"] = "running"
            job["started_at"] = time.time()
            _active_job_id = jid
            _persist(job)

        try:
            _run_one(job)
        except Exception as e:
            log.exception(f"job {jid} crashed: {e}")
            with _lock:
                job["status"] = "failed"
                job["error"] = repr(e)
                job["finished_at"] = time.time()
                _persist(job)
        finally:
            with _lock:
                _active_job_id = None
            # Each completed job resets the idle watchdog so the
            # session has a fresh window before auto-shutdown.
            try:
                from backend import idle_watchdog
                idle_watchdog.touch()
            except Exception:
                pass


def _run_one(job: dict[str, Any]):
    """Execute one pipeline run and upload the result to remote storage."""
    from main import run_pipeline
    from modules import run_state
    from backend import logbuf
    # Bridge run_state updates back to this job record.
    job_id = job["id"]

    # req_id propagation — every log line emitted from any thread that
    # inherits this context will carry the id. Vercel passes its req_id
    # via X-Request-Id when dispatching; we fall back to the job id when
    # no upstream header existed.
    req_id = str(job.get("req_id") or job_id)[:12]
    logbuf.set_req_id(req_id)
    log.info(f"job worker started for {job_id} (req_id={req_id})")

    # Refresh central API keys BEFORE the pipeline runs. This lets keys
    # saved via the dashboard AFTER worker boot reach the running
    # process — otherwise nim/scriptwriter/footage would see the empty
    # env vars snapshot from boot time.
    try:
        from backend import keys_sync
        keys_sync.pull_into_env(override=True)
    except Exception as _e:
        log.warning(f"keys_sync.pull_into_env failed pre-job: {_e}")

    def progress_bridge():
        last = {"percent": -1, "step": None}
        while True:
            time.sleep(0.4)
            s = run_state.read()
            if s.get("percent") != last["percent"] or s.get("current_step") != last["step"]:
                last["percent"] = s.get("percent", 0)
                last["step"] = s.get("current_step")
                update_progress(s.get("percent", 0),
                                s.get("current_step", "") or "",
                                s.get("current_step_label", "") or "")
            if s.get("status") in ("complete", "failed"):
                # Capture run_id for download path.
                with _lock:
                    job["run_id"] = s.get("run_id") or job.get("run_id")
                    _persist(job)
                return

    pt = threading.Thread(target=progress_bridge, daemon=True)
    pt.start()

    ok = run_pipeline(
        channel_type=job["channel"],
        dry_run=job["dry_run"],
        manual_topic=job.get("manual_topic", ""),
        manual_script=job.get("manual_script", ""),
        manual_title=job.get("manual_title", ""),
        manual_images=job.get("manual_images") or [],
        manual_channel_desc=job.get("manual_channel_desc", ""),
        web_research=job.get("web_research"),
        real_events=job.get("real_events"),
        language=job.get("language"),
        voice_override=job.get("voice_override"),
        youtube_account_id=job.get("youtube_account_id"),
    )

    # Pipeline finished — final state and (optionally) upload.
    final_state = run_state.read()
    with _lock:
        job["run_id"] = final_state.get("run_id") or job.get("run_id")
        local_path = final_state.get("video_path")
        upload_error = ""
        public = ""
        if ok and local_path and os.path.exists(local_path):
            try:
                from backend import storage
                if storage.is_configured():
                    public = storage.upload_video(local_path, job["run_id"])
                    job["public_url"] = public
                    log.info(f"job {job_id} uploaded to {public}")
            except Exception as e:
                upload_error = str(e)
                log.warning(f"job {job_id} upload skipped: {upload_error}")

            # Terminal status: rendered locally OK. Upload failure is
            # SURFACED as a job error but the job is still marked
            # complete-with-warning — the local file exists, the run
            # summary is persisted, and the Library shows an entry.
            job["status"] = "complete"
            if public:
                job["video_url"] = public
            else:
                # Fallback: dashboard-hosted route serving from local disk
                # (only works while the worker container lives).
                job["video_url"] = f"/api/runs/{job['run_id']}/video"
                if upload_error:
                    job["error"] = f"upload failed: {upload_error[:400]}"

            # Persist the run summary + index UNCONDITIONALLY so the
            # Library page shows every completed render — even ones
            # whose upload failed. The frontend can then show a
            # "download failed" chip and offer a re-upload button.
            try:
                from pathlib import Path as _Path
                summary_path = _Path("output/videos") / job["run_id"] / "run_summary.json"
                summary: dict = {}
                if summary_path.exists():
                    import json as _json
                    try:
                        summary = _json.loads(summary_path.read_text(encoding="utf-8"))
                    except Exception as _e:
                        log.warning(f"summary read failed for {job['run_id']}: {_e}")
                summary["run_id"] = job["run_id"]
                summary["video_url"] = public or job["video_url"]
                summary["finished_at"] = time.time()
                summary["channel"] = job.get("channel")
                summary["dry_run"] = job.get("dry_run", False)
                summary["ok"] = True
                summary["upload_error"] = upload_error or ""

                from backend import runs_db
                runs_db.write_run(
                    job["run_id"],
                    summary=summary,
                    index_entry={
                        "channel":       summary.get("channel"),
                        "dry_run":       summary.get("dry_run", False),
                        "ok":            True,
                        "finished_at":   summary["finished_at"],
                        "video_url":     public or job["video_url"],
                        "has_video":     bool(public),
                        "video_storage": "primary" if public else "local",
                        "upload_error":  upload_error[:400] if upload_error else "",
                        "title":         (summary.get("title") or "").strip(),
                    },
                )
            except Exception as _e:
                log.warning(f"job {job_id} run-summary mirror failed: {_e}")
        else:
            job["status"] = "failed"
            job["error"] = final_state.get("error") or "pipeline failed"

            # Even on failure, mirror an index entry so the Library shows
            # every attempt with a red chip instead of silently swallowing.
            try:
                from backend import runs_db
                runs_db.write_run(
                    job["run_id"],
                    summary={
                        "run_id":      job["run_id"],
                        "channel":     job.get("channel"),
                        "ok":          False,
                        "error":       job["error"],
                        "finished_at": time.time(),
                    },
                    index_entry={
                        "channel":     job.get("channel"),
                        "ok":          False,
                        "error":       job["error"][:400],
                        "finished_at": time.time(),
                        "has_video":   False,
                    },
                )
            except Exception as _e:
                log.warning(f"job {job_id} failure-index mirror failed: {_e}")

        # Fire a Discord alert for terminal status. Best-effort —
        # notifier swallows all errors so a broken webhook can't break
        # the job worker.
        try:
            from backend import notifier
            elapsed = int(time.time() - (job.get("started_at") or time.time()))
            # Worker identity in the embed — tells you at a glance whether
            # Colab, Kaggle, or HF Space handled the job.
            worker_label = os.getenv("INSTANCE_LABEL") or "unknown"
            if job["status"] == "complete":
                notifier.info(
                    f"✅ Pipeline complete · {job.get('channel', 'unknown')}",
                    body=f"Run `{job['run_id']}` finished in {elapsed}s",
                    fields=[
                        ("worker", worker_label, True),
                        ("dry_run", str(job.get("dry_run", False)), True),
                        ("public_url", job.get("public_url") or "—", False),
                    ],
                    url=job.get("public_url") or None,
                )
            else:
                # Persist to Firestore `errors` collection + fire the
                # Discord embed in one call. The /health page reads
                # from errors to show the last N failures.
                from backend import logbuf as _lb
                notifier.report_error(
                    err=str(job.get("error") or "unknown pipeline failure"),
                    title=f"❌ Pipeline failed · {job.get('channel', 'unknown')}",
                    run_id=job.get("run_id") or job["id"],
                    req_id=_lb.current_req_id(),
                    extra={
                        "worker":  worker_label,
                        "elapsed": elapsed,
                        "dry_run": bool(job.get("dry_run", False)),
                    },
                )
        except Exception as _e:
            log.debug(f"notifier hook failed: {_e}")

        job["finished_at"] = time.time()
        job["percent"] = 100 if ok else job.get("percent", 0)
        _persist(job)


# Hydrate from disk on import so prior runs survive restarts.
_load_persisted()
