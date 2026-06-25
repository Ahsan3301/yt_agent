"""
registry.py — Self-register this backend in a shared registry.json on Hostinger.

Each backend instance (one per Colab session) publishes itself with:
    {
      "instance_id":  stable per-Colab-session id
      "url":          public Cloudflare tunnel URL
      "status":       "available" | "busy"
      "queue_depth":  int
      "started_at":   epoch
      "last_seen":    epoch
      "channel":      "horror"     (just informational)
      "version":      "1.x"
    }

The frontend (Vercel) fetches registry.json over plain HTTPS from Hostinger
and picks the first available backend (or the least-loaded busy one).

Heartbeat thread refreshes the registry every HEARTBEAT_INTERVAL seconds.
"""
import os
import time
import uuid
import socket
import logging
import threading
import requests

from backend import storage

log = logging.getLogger(__name__)

REGISTRY_FILENAME = os.getenv("REGISTRY_FILENAME", "registry.json")
HEARTBEAT_INTERVAL = int(os.getenv("REGISTRY_HEARTBEAT_SECONDS", "30") or 30)
STALE_AFTER = int(os.getenv("REGISTRY_STALE_AFTER_SECONDS", "120") or 120)

# Per-instance metadata
INSTANCE_ID = os.getenv("INSTANCE_ID") or f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}"
PUBLIC_URL = os.getenv("PUBLIC_BACKEND_URL", "")  # set by the Colab notebook after cloudflared

_lock = threading.Lock()
_running = False
_status = "available"


def public_url() -> str:
    return os.getenv("PUBLIC_BACKEND_URL", PUBLIC_URL)


def set_status(status: str):
    """Called by jobs.py when the queue transitions busy/available."""
    global _status
    _status = status


def _read_remote() -> list[dict]:
    """Fetch the current registry.json from Hostinger via HTTPS (not FTP —
    plain GET is faster and works without writing credentials)."""
    base = (os.getenv("PUBLIC_BASE_URL", "") or "").rstrip("/")
    if not base:
        return []
    try:
        r = requests.get(f"{base}/{REGISTRY_FILENAME}", timeout=10,
                         headers={"Cache-Control": "no-cache"})
        if r.status_code != 200:
            return []
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        log.debug(f"registry read miss: {e}")
        return []


def _merge_self(entries: list[dict], from_jobs_queue_depth: int = 0) -> list[dict]:
    """Drop my old entry, prune stale entries, append a fresh one for me."""
    now = time.time()
    fresh = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        if e.get("instance_id") == INSTANCE_ID:
            continue                               # replace below
        if now - float(e.get("last_seen", 0)) > STALE_AFTER:
            continue                               # stale neighbour — drop
        fresh.append(e)

    me = {
        "instance_id":  INSTANCE_ID,
        "url":          public_url(),
        "status":       _status,
        "queue_depth":  from_jobs_queue_depth,
        "started_at":   _startup_epoch,
        "last_seen":    now,
        "version":      "1.0",
    }
    fresh.append(me)
    return fresh


def push_now(queue_depth: int = 0):
    """Publish a heartbeat immediately."""
    if not storage.is_configured():
        return
    if not public_url():
        return  # tunnel not up yet
    entries = _read_remote()
    new = _merge_self(entries, from_jobs_queue_depth=queue_depth)
    try:
        url = storage.upload_json(REGISTRY_FILENAME, new)
        log.debug(f"registry heartbeat ok → {url} ({_status}, depth={queue_depth})")
    except Exception as e:
        log.warning(f"registry heartbeat upload failed: {e}")


def deregister():
    """Best-effort: remove ourselves on graceful shutdown."""
    if not storage.is_configured() or not public_url():
        return
    entries = _read_remote()
    entries = [e for e in entries if e.get("instance_id") != INSTANCE_ID]
    try:
        storage.upload_json(REGISTRY_FILENAME, entries)
        log.info("registry: deregistered cleanly")
    except Exception as e:
        log.warning(f"registry deregister failed: {e}")


def start():
    """Spawn the heartbeat thread. Idempotent."""
    global _running, _startup_epoch
    if _running:
        return
    if not storage.is_configured():
        log.info("registry: storage not configured — skipping heartbeat")
        return
    _running = True
    _startup_epoch = time.time()

    def _loop():
        from backend import jobs
        while _running:
            depth = jobs.queue_depth()
            new_status = "busy" if jobs.is_busy() else "available"
            if new_status != _status:
                set_status(new_status)
            push_now(queue_depth=depth)
            time.sleep(HEARTBEAT_INTERVAL)

    t = threading.Thread(target=_loop, daemon=True, name="registry-heartbeat")
    t.start()
    log.info(f"registry heartbeat started "
             f"(every {HEARTBEAT_INTERVAL}s; instance_id={INSTANCE_ID})")


_startup_epoch = time.time()
