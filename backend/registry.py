"""
registry.py — Self-register this backend in the Firestore `backends` collection.

Each backend writes one document keyed by its instance_id. The frontend
subscribes to the collection via onSnapshot and gets instant updates
when backends come and go — no polling, no CDN caching, no CORS dance.

Document shape:
    backends/<instance_id> {
      url:         "https://xxx.trycloudflare.com",
      status:      "available" | "busy",
      queue_depth: int,
      tier:        "gpu" | "cpu",
      label:       str | None,
      version:     "2.0",
      started_at:  Timestamp,
      last_seen:   Timestamp,       # server timestamp on every write
    }

Heartbeat thread refreshes the doc every HEARTBEAT_INTERVAL seconds.
"""
from __future__ import annotations
import os
import time
import uuid
import socket
import logging
import threading

from backend import db

log = logging.getLogger(__name__)

HEARTBEAT_INTERVAL = int(os.getenv("REGISTRY_HEARTBEAT_SECONDS", "30") or 30)

# Per-instance metadata.
INSTANCE_ID = os.getenv("INSTANCE_ID") or f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}"
PUBLIC_URL = os.getenv("PUBLIC_BACKEND_URL", "")    # set by the Colab notebook after cloudflared
INSTANCE_TIER = (os.getenv("INSTANCE_TIER", "gpu") or "gpu").lower()
INSTANCE_LABEL = os.getenv("INSTANCE_LABEL", "")

# Back-compat — used by /api/debug/heartbeat in server.py.
REGISTRY_FILENAME = "backends"   # now a Firestore collection name

_status = "available"
_running = False
_startup_epoch = time.time()


def public_url() -> str:
    return os.getenv("PUBLIC_BACKEND_URL", PUBLIC_URL)


def set_status(status: str):
    """Called by jobs.py when the queue transitions busy/available."""
    global _status
    _status = status


def _self_payload(queue_depth: int) -> dict:
    return {
        "instance_id":  INSTANCE_ID,
        "url":          public_url(),
        "status":       _status,
        "queue_depth":  int(queue_depth),
        "tier":         INSTANCE_TIER,
        "label":        INSTANCE_LABEL or None,
        "version":      "2.0",
        "started_at":   _startup_epoch,
        "last_seen":    db.server_timestamp(),
    }


def push_now(queue_depth: int = 0):
    """Publish a heartbeat immediately."""
    if not db.is_configured():
        return
    if not public_url():
        return  # tunnel not up yet
    try:
        c = db.client()
        c.collection("backends").document(INSTANCE_ID).set(
            _self_payload(queue_depth), merge=True
        )
        log.debug(f"heartbeat ok ({_status}, depth={queue_depth})")
    except Exception as e:
        log.warning(f"heartbeat write failed: {e}")


def deregister():
    """Best-effort: remove ourselves on graceful shutdown."""
    if not db.is_configured() or not public_url():
        return
    try:
        c = db.client()
        c.collection("backends").document(INSTANCE_ID).delete()
        log.info(f"deregistered {INSTANCE_ID}")
    except Exception as e:
        log.warning(f"deregister failed: {e}")


def start():
    """Spawn the heartbeat thread. Idempotent."""
    global _running, _startup_epoch
    if _running:
        return
    if not db.is_configured():
        log.info("registry: Firestore not configured — skipping heartbeat")
        return
    _running = True
    _startup_epoch = time.time()

    def _loop():
        from backend import jobs, jobs_db
        while _running:
            try:
                depth = jobs.queue_depth()
                new_status = "busy" if jobs.is_busy() else "available"
                if new_status != _status:
                    set_status(new_status)
                push_now(queue_depth=depth)
                # Queue-claim: if we're idle, look for a job that was
                # submitted via Vercel while no worker was alive (or
                # while we were busy). One job per cycle keeps load
                # predictable.
                if not jobs.is_busy() and public_url():
                    claimed = jobs_db.claim_queued(INSTANCE_ID, public_url())
                    if claimed:
                        jobs.adopt_remote(claimed)
            except Exception as e:
                log.warning(f"heartbeat loop error: {e}")
            time.sleep(HEARTBEAT_INTERVAL)

    t = threading.Thread(target=_loop, daemon=True, name="registry-heartbeat")
    t.start()
    log.info(f"registry heartbeat started "
             f"(every {HEARTBEAT_INTERVAL}s; instance_id={INSTANCE_ID})")
