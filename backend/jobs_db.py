"""
jobs_db.py — Firestore-backed mirror of the in-flight jobs table.

Without this, the Vercel API gateway can't see jobs that landed on a
particular backend, and a status check routed to a different backend
404s. Each `_persist(job)` call in backend/jobs.py also writes here so
the source of truth lives in Firestore.

Document layout: jobs/<job_id> {
    id, status, channel, dry_run,
    queued_at, started_at, finished_at,
    percent, current_step, current_step_label,
    run_id, video_url, public_url, error,
    backend_instance_id,                  # who's handling this (or null)
    backend_url,                          # where to proxy status checks
    updated_at: server timestamp
}

Atomic claim: claim_queued() runs in a Firestore transaction so two
workers picking the same queued job at once can't both win — one of
the transactions sees the changed backend_instance_id and aborts.
"""
from __future__ import annotations
import logging
from typing import Any

from backend import db

log = logging.getLogger(__name__)

COLLECTION = "jobs"


def upsert_job(job: dict[str, Any]) -> bool:
    """Mirror a job record to Firestore. Best-effort — returns False on
    failure rather than raising; the local in-memory state is still the
    source of truth for the running process."""
    if not db.is_configured():
        return False
    rid = job.get("id")
    if not rid:
        return False
    try:
        c = db.client()
        payload = dict(job)
        payload["updated_at"] = db.server_timestamp()
        # Fill in routing metadata if missing.
        payload.setdefault("backend_instance_id", None)
        payload.setdefault("backend_url", None)
        c.collection(COLLECTION).document(rid).set(payload, merge=True)
        return True
    except Exception as e:
        log.warning(f"jobs_db.upsert_job({rid}) failed: {e}")
        return False


def get_job(job_id: str) -> dict | None:
    if not db.is_configured():
        return None
    try:
        snap = db.client().collection(COLLECTION).document(job_id).get()
        if not snap.exists:
            return None
        return snap.to_dict() or None
    except Exception as e:
        log.warning(f"jobs_db.get_job({job_id}) failed: {e}")
        return None


def delete_job(job_id: str) -> bool:
    if not db.is_configured():
        return False
    try:
        db.client().collection(COLLECTION).document(job_id).delete()
        return True
    except Exception as e:
        log.warning(f"jobs_db.delete_job({job_id}) failed: {e}")
        return False


def list_for_backend(instance_id: str, limit: int = 50) -> list[dict]:
    """Used at startup to rehydrate in-flight jobs that this backend
    was running before the process died."""
    if not db.is_configured() or not instance_id:
        return []
    try:
        c = db.client()
        q = (c.collection(COLLECTION)
              .where("backend_instance_id", "==", instance_id)
              .limit(limit))
        out = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d.setdefault("id", snap.id)
            out.append(d)
        return out
    except Exception as e:
        log.warning(f"jobs_db.list_for_backend({instance_id}) failed: {e}")
        return []


def claim_queued(instance_id: str, instance_url: str) -> dict | None:
    """Atomically claim ONE queued job whose backend_instance_id is null.

    Query strategy avoids composite-index requirement: filter on a
    single field (status=='queued') and do the null-check + sort
    client-side. Firestore reads a few extra docs per call but at our
    scale (handful of in-flight jobs) it's nothing — and it means a
    fresh deploy doesn't need anyone to click 'Create Index' in the
    Firebase console.

    Uses a Firestore transaction so two backends polling at the same
    time don't both grab the same job — only one transaction wins; the
    other sees backend_instance_id already populated and returns None.
    """
    if not db.is_configured() or not instance_id:
        return None
    try:
        from firebase_admin import firestore as _fs
        c = db.client()

        # Honour the global queue-pause flag set via the dashboard.
        # Already-running jobs continue; we just don't claim new ones.
        try:
            qs = c.collection("queue_state").document("global").get()
            if qs.exists and (qs.to_dict() or {}).get("paused"):
                return None
        except Exception:
            pass  # if the read fails, default to NOT paused

        # Single equality filter — no composite index required.
        q = c.collection(COLLECTION).where("status", "==", "queued").limit(20)

        candidates = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            if d.get("backend_instance_id"):
                continue
            d["__snap_id"] = snap.id
            d.setdefault("queued_at", 0)
            candidates.append(d)
        if not candidates:
            return None

        # Oldest first — fair scheduling.
        candidates.sort(key=lambda x: float(x.get("queued_at") or 0))
        target_id = candidates[0]["__snap_id"]

        @_fs.transactional
        def _txn(txn):
            ref = c.collection(COLLECTION).document(target_id)
            cur = ref.get(transaction=txn).to_dict() or {}
            if cur.get("backend_instance_id"):
                return None  # raced — someone else claimed it
            cur["backend_instance_id"] = instance_id
            cur["backend_url"] = instance_url
            cur["status"] = "running"
            cur["started_at"] = cur.get("started_at") or _ts_now()
            cur["updated_at"] = db.server_timestamp()
            txn.set(ref, cur, merge=True)
            cur["id"] = target_id
            return cur

        txn = c.transaction()
        return _txn(txn)
    except Exception as e:
        log.warning(f"jobs_db.claim_queued({instance_id}) failed: {e}")
        return None


def _ts_now() -> float:
    import time
    return time.time()
