"""
runs_db.py — Firestore-backed history of completed/failed runs.

Two collections so the History list query doesn't drag full summaries
into the wire:

    runs_index/<run_id> {
        channel, dry_run, ok, finished_at, video_url, has_video,
        video_storage, started_at?
    }
    run_summaries/<run_id> {
        data: { ...full summary including shots, timings, etc. },
        updated_at: Timestamp,
    }
"""
from __future__ import annotations
import logging
from typing import Any, Iterable

from backend import db

log = logging.getLogger(__name__)


def _ts_to_seconds(v: Any) -> float | None:
    """Firestore returns datetime; downstream code expects epoch float."""
    if v is None:
        return None
    if hasattr(v, "timestamp"):
        try:
            return float(v.timestamp())
        except Exception:
            return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def write_run(run_id: str, summary: dict, index_entry: dict) -> bool:
    """Atomic-ish write of both the index entry and full summary. Best-effort —
    returns False on any failure rather than raising; the local copy is still
    the source of truth for the running process."""
    if not db.is_configured():
        return False
    # Guard: empty run_id would land as a junk row (all-blank fields) in PB
    # and, worse, monopolise the row-with-empty-run_id unique-index slot so
    # every subsequent failed run's write collides. Skip cleanly instead.
    if not run_id or not str(run_id).strip():
        log.warning("runs_db.write_run: refusing to write row with empty run_id")
        return False
    try:
        c = db.client()
        batch = c.batch()

        idx_ref = c.collection("runs_index").document(run_id)
        entry = dict(index_entry)
        entry["updated_at"] = db.server_timestamp()
        batch.set(idx_ref, entry, merge=True)

        sum_ref = c.collection("run_summaries").document(run_id)
        # merge=True so a retry after a failed run overwrites the earlier
        # failure row instead of colliding on the run_id unique index.
        # PB's create-only path raises validation_not_unique otherwise.
        batch.set(sum_ref, {
            "data": summary,
            "updated_at": db.server_timestamp(),
        }, merge=True)

        batch.commit()
        return True
    except Exception as e:
        log.warning(f"runs_db.write_run({run_id}) failed: {e}")
        return False


def list_index(limit: int = 200) -> list[dict]:
    """Return the index ordered by finished_at descending.

    Uses the db wrapper's own order_by so it works on both Firestore
    (Admin SDK) and Pocketbase — DO NOT import firebase_admin.firestore
    directly, that dep isn't present on PB-only workers and would
    raise ImportError, killing the /api/runs page silently."""
    if not db.is_configured():
        return []
    try:
        c = db.client()
        q = c.collection("runs_index").order_by("finished_at", "DESCENDING").limit(limit)
        out = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d.setdefault("run_id", snap.id)
            # Guard against null finished_at from in-progress or failed
            # rows — sort-side null handling differs between backends.
            d["finished_at"] = _ts_to_seconds(d.get("finished_at")) or 0.0
            out.append(d)
        # Post-sort as a belt-and-braces guarantee so partial rows
        # never leak above complete ones.
        out.sort(key=lambda r: r.get("finished_at") or 0.0, reverse=True)
        return out
    except Exception as e:
        log.warning(f"runs_db.list_index failed: {e}")
        return []


def fetch_summary(run_id: str) -> dict | None:
    if not db.is_configured():
        return None
    try:
        snap = db.client().collection("run_summaries").document(run_id).get()
        if not snap.exists:
            return None
        data = (snap.to_dict() or {}).get("data")
        return data if isinstance(data, dict) else None
    except Exception as e:
        log.warning(f"runs_db.fetch_summary({run_id}) failed: {e}")
        return None


def delete_run(run_id: str) -> bool:
    """Remove both the index entry and the full summary."""
    if not db.is_configured():
        return False
    try:
        c = db.client()
        c.collection("runs_index").document(run_id).delete()
        c.collection("run_summaries").document(run_id).delete()
        return True
    except Exception as e:
        log.warning(f"runs_db.delete_run({run_id}) failed: {e}")
        return False
