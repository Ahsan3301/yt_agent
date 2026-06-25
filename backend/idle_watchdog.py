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
"""
import os
import time
import logging
import threading

log = logging.getLogger(__name__)

IDLE_TIMEOUT_SECONDS = int(os.getenv("IDLE_TIMEOUT_SECONDS", "600") or 600)
IDLE_CHECK_INTERVAL  = int(os.getenv("IDLE_CHECK_INTERVAL",  "30")  or 30)
IDLE_STARTUP_GRACE   = int(os.getenv("IDLE_STARTUP_GRACE",   "300") or 300)

_lock = threading.Lock()
_last_active = time.time()
_started_at  = time.time()
_running     = False


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

    # 3) Hard-exit. Skip atexit hooks (we already cleaned up); os._exit is
    #    the only way to be sure uvicorn workers actually stop.
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
                 f"startup_grace={IDLE_STARTUP_GRACE}s)")
        from backend import jobs
        while _running:
            time.sleep(IDLE_CHECK_INTERVAL)
            since_boot = time.time() - _started_at
            if since_boot < IDLE_STARTUP_GRACE:
                continue
            # Activity = any job running OR queued.
            if jobs.is_busy() or jobs.queue_depth() > 0:
                touch()
                continue
            if idle_seconds() >= IDLE_TIMEOUT_SECONDS:
                _shutdown()
                return  # unreachable

    t = threading.Thread(target=_loop, daemon=True, name="idle-watchdog")
    t.start()
