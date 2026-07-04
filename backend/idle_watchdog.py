"""
idle_watchdog.py — Auto-terminate the backend (and the Colab runtime)
when no jobs are running and no user activity has been seen for a while.

Why: Colab free tier has a hard compute budget. If you open the dashboard
once a day to render a video, you don't want a notebook quietly burning
your hours overnight.

How it works:
  • `touch()` is called on every HTTP request (via middleware) AND every
    time a job finishes. This updates `_last_active`.
  • A background thread checks every IDLE_CHECK_INTERVAL seconds: if
    `now - _last_active` exceeds IDLE_TIMEOUT_SECONDS AND no job is
    running AND the queue is empty → shut down.
  • Shutdown order: deregister from the Hostinger registry → try to
    disconnect the Colab runtime → exit the process.

Configure via .env:
    IDLE_TIMEOUT_SECONDS=600     # 10 min of total quiet → die. 0 = disabled.
    IDLE_CHECK_INTERVAL=30       # how often the watchdog checks
    IDLE_STARTUP_GRACE=300       # don't shut down within N seconds of boot
    KAGGLE_AUTO_SHUTDOWN_AFTER_IDLE_SECONDS=600  # Kaggle override (see below)

Kaggle quirks (when running on a Kaggle Notebook GPU runner):
  • We're a one-shot worker woken on-demand by the GitHub Actions
    dispatch cron. Once the queue empties we want to release the GPU
    promptly to preserve the 30 hr/week budget.
  • Setting KAGGLE_AUTO_SHUTDOWN_AFTER_IDLE_SECONDS overrides
    IDLE_TIMEOUT_SECONDS — same semantics, different default.
  • The watchdog also considers "queued in Firestore (claimable)" as
    activity so we don't die before claiming the job that woke us up.
"""
import os
import time
import logging
import threading

log = logging.getLogger(__name__)

_KAGGLE_OVERRIDE = int(os.getenv("KAGGLE_AUTO_SHUTDOWN_AFTER_IDLE_SECONDS", "0") or 0)
IDLE_TIMEOUT_SECONDS = _KAGGLE_OVERRIDE or int(os.getenv("IDLE_TIMEOUT_SECONDS", "600") or 600)
IDLE_CHECK_INTERVAL  = int(os.getenv("IDLE_CHECK_INTERVAL",  "30")  or 30)
IDLE_STARTUP_GRACE   = int(os.getenv("IDLE_STARTUP_GRACE",   "300") or 300)

# Detect if we're on Kaggle even without the env var set. Kaggle's
# runtime always mounts /kaggle. Users forget to set the env var and
# then watch their weekly GPU quota disappear when a stuck job pins
# is_busy()=True for hours.
_ON_KAGGLE = os.path.isdir("/kaggle") or bool(os.getenv("KAGGLE_KERNEL_RUN_TYPE"))

# Absolute ceiling on session lifetime regardless of activity.
# 2 h on Kaggle (auto-detected — user report: worker ran 14 h and
# burned weekly quota when SDXL model download stalled + is_busy
# stuck True → watchdog kept resetting), off elsewhere (Colab + HF
# Space should never be auto-killed against user's will).
HARD_MAX_LIFETIME_SECONDS = int(
    os.getenv("HARD_MAX_LIFETIME_SECONDS",
              "7200" if _ON_KAGGLE else "0") or 0
)

# Stuck-busy cap. If jobs.is_busy() returns True continuously for this
# long, treat the worker as WEDGED and force shutdown. Real renders
# finish in 5-10 min; if we've been "busy" for 30+ min the job has
# hung (SDXL stall, ffmpeg deadlock, network drop mid-upload). Better
# to kill and let the next Kaggle wake pick up a fresh session than
# waste hours of the free-tier weekly quota. Off if <= 0.
BUSY_STUCK_SECONDS = int(
    os.getenv("BUSY_STUCK_SECONDS",
              "1800" if _ON_KAGGLE else "0") or 0
)
_busy_since: float | None = None

_lock = threading.Lock()
_last_active = time.time()
_started_at  = time.time()
_running     = False


def _firestore_queued_for_us() -> int:
    """Count Firestore jobs with status==queued AND no backend yet.
    Best-effort: any error returns 0 (we just fall through to the
    timeout-based shutdown). Used to keep Kaggle workers alive while
    a queued job is still floating around waiting to be claimed."""
    try:
        from backend import db
        if not db.is_configured():
            return 0
        snap = (
            db.client()
            .collection("jobs")
            .where("status", "==", "queued")
            .limit(10)
            .stream()
        )
        n = 0
        for doc in snap:
            v = doc.to_dict() or {}
            if not v.get("backend_instance_id"):
                n += 1
        return n
    except Exception:
        return 0


def touch():
    """Call this on every meaningful activity (HTTP request, job done)."""
    global _last_active
    with _lock:
        _last_active = time.time()


def idle_seconds() -> float:
    with _lock:
        return time.time() - _last_active


def _shutdown():
    """Best-effort full session termination."""
    log.warning("idle watchdog: shutting down session "
                f"(idle {int(idle_seconds())}s ≥ {IDLE_TIMEOUT_SECONDS}s)")
    # 1) Drop ourselves from the registry so the frontend stops routing.
    try:
        from backend import registry
        registry.deregister()
    except Exception as e:
        log.warning(f"registry.deregister failed: {e}")

    # 2) If running inside Google Colab, disconnect the runtime — this
    #    releases the GPU and stops the free-tier compute clock.
    try:
        from google.colab import runtime as _colab_runtime  # type: ignore
        log.warning("idle watchdog: calling google.colab.runtime.unassign()")
        _colab_runtime.unassign()
    except Exception:
        pass  # not running in Colab, that's fine

    # 3) On Kaggle the parent kernel is papermill; SIGTERM-ing the
    #    process group ensures every worker uvicorn spawned exits
    #    before we hard-exit. Without this, os._exit(0) only kills the
    #    current process and uvicorn's main loop survives in another
    #    pid, keeping the kernel "Running" forever.
    try:
        import signal
        pgid = os.getpgid(0)
        log.warning(f"idle watchdog: SIGTERM to process group {pgid}")
        os.killpg(pgid, signal.SIGTERM)
    except Exception as e:
        log.debug(f"killpg failed (Windows / restricted env): {e}")

    # 4) Hard-exit. Skip atexit hooks (we already cleaned up); os._exit
    #    is the only way to be sure uvicorn workers actually stop.
    os._exit(0)


def start():
    """Spawn the watchdog thread. No-op if IDLE_TIMEOUT_SECONDS <= 0."""
    global _running
    if _running:
        return
    if IDLE_TIMEOUT_SECONDS <= 0:
        log.info("idle watchdog disabled (IDLE_TIMEOUT_SECONDS<=0)")
        return
    _running = True

    def _loop():
        # Honour the startup grace period — gives the user time to submit
        # their first job after launching the Colab notebook.
        log.info(f"idle watchdog running "
                 f"(timeout={IDLE_TIMEOUT_SECONDS}s, "
                 f"check_every={IDLE_CHECK_INTERVAL}s, "
                 f"startup_grace={IDLE_STARTUP_GRACE}s, "
                 f"hard_max={HARD_MAX_LIFETIME_SECONDS}s)")
        from backend import jobs
        while _running:
            time.sleep(IDLE_CHECK_INTERVAL)
            since_boot = time.time() - _started_at

            # Absolute ceiling — fires no matter what. Catches the
            # "watchdog never shuts down because something keeps
            # touching it" failure mode on Kaggle.
            if HARD_MAX_LIFETIME_SECONDS > 0 and since_boot >= HARD_MAX_LIFETIME_SECONDS:
                log.warning(
                    f"idle watchdog: HARD_MAX_LIFETIME_SECONDS={HARD_MAX_LIFETIME_SECONDS}s "
                    f"reached (uptime={int(since_boot)}s); shutting down regardless of activity"
                )
                _shutdown()
                return

            if since_boot < IDLE_STARTUP_GRACE:
                continue

            # Activity = local job running/queued OR Firestore-queued
            # job we might still claim. The Firestore check matters on
            # Kaggle: the worker is woken with a queued job pending,
            # and the claim transaction takes a tick after boot.
            local_busy = jobs.is_busy()
            local_q = jobs.queue_depth()
            remote_q = _firestore_queued_for_us()
            idle = idle_seconds()
            log.info(
                f"idle watchdog tick: uptime={int(since_boot)}s "
                f"idle={int(idle)}s/{IDLE_TIMEOUT_SECONDS}s "
                f"local_busy={local_busy} local_q={local_q} remote_q={remote_q}"
            )

            # Stuck-busy detection. is_busy() gets pinned True if a
            # render step hangs (SDXL model download stall, ffmpeg
            # wait-forever, TCP drop mid-upload). Without this check the
            # watchdog resets on every tick and never shuts down.
            global _busy_since
            if local_busy:
                if _busy_since is None:
                    _busy_since = time.time()
                busy_for = time.time() - _busy_since
                if BUSY_STUCK_SECONDS > 0 and busy_for >= BUSY_STUCK_SECONDS:
                    log.warning(
                        f"idle watchdog: STUCK-BUSY {int(busy_for)}s "
                        f">= BUSY_STUCK_SECONDS={BUSY_STUCK_SECONDS}s — "
                        f"job wedged, force-shutdown to preserve quota"
                    )
                    _shutdown()
                    return
            else:
                _busy_since = None

            if local_busy or local_q > 0:
                touch()
                continue
            if remote_q > 0:
                touch()
                continue
            if idle >= IDLE_TIMEOUT_SECONDS:
                _shutdown()
                return  # unreachable

    t = threading.Thread(target=_loop, daemon=True, name="idle-watchdog")
    t.start()
