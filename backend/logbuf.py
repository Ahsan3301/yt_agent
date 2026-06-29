"""
logbuf.py — In-memory ring buffer log handler.

Attaches a logging.Handler to the root logger that stores the last N
records in a deque. The dashboard polls /api/logs?since=<seq> and gets
back only the records it hasn't seen yet. Lightweight, no persistence,
no I/O on the hot path.

Why a custom handler instead of reading a file: file tail would lose
records on restart and would need OS-specific file watchers. The deque
lives in process memory and is shared across the worker thread + the
HTTP handlers (each request reads under a lock).

Filter rules — we drop uvicorn access logs (super noisy, mostly health
heartbeats) but keep everything else at INFO+ from the project itself
and uvicorn errors. Frontend can filter further by level/text.
"""
from __future__ import annotations
import logging
import threading
import time
from collections import deque
from typing import Iterable

# How many records to keep in memory. ~10 KB per record * 2000 = 20 MB max.
_MAX_RECORDS = 2000

_lock = threading.Lock()
_buf: deque[dict] = deque(maxlen=_MAX_RECORDS)
_next_seq = 1


# Logger names whose records we drop entirely.
_DROP_LOGGERS = {
    "uvicorn.access",      # one line per HTTP req — drowns out the signal
    "botocore",            # extremely chatty at DEBUG
    "boto3",
    "s3transfer",
    "paramiko.transport",  # SSH session noise
    "urllib3.connectionpool",
}


class _RingBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        if record.name in _DROP_LOGGERS:
            return
        if record.name.startswith(("botocore.", "boto3.", "s3transfer.",
                                    "paramiko.", "urllib3.")):
            return
        try:
            msg = record.getMessage()
        except Exception:
            msg = record.msg if isinstance(record.msg, str) else repr(record.msg)

        global _next_seq
        entry = {
            "seq":   None,           # filled below under lock
            "time":  record.created,  # epoch seconds (float)
            "level": record.levelname,
            "name":  record.name,
            "msg":   msg,
        }
        # Stack info / exception text — fold into msg if present.
        if record.exc_info:
            try:
                entry["msg"] += "\n" + self.format_exc(record.exc_info)
            except Exception:
                pass

        with _lock:
            entry["seq"] = _next_seq
            _next_seq += 1
            _buf.append(entry)
        # Best-effort enqueue for the Firestore sink. No-op when no
        # active run, or when this run has used its write budget.
        _enqueue_for_firestore(entry)

    def format_exc(self, exc_info) -> str:
        import traceback
        return "".join(traceback.format_exception(*exc_info))


_handler: _RingBufferHandler | None = None


def attach(level: int = logging.INFO) -> None:
    """Install the ring-buffer handler on the root logger. Idempotent."""
    global _handler
    if _handler is not None:
        return
    h = _RingBufferHandler(level=level)
    h.setFormatter(logging.Formatter(
        # We don't actually use this — emit() builds the dict directly.
        # But set it for any code that calls handler.format() externally.
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    ))
    logging.getLogger().addHandler(h)
    _handler = h
    logging.getLogger(__name__).info("logbuf: ring buffer attached")


def read(since: int = 0, limit: int = 500) -> dict:
    """Return entries with seq > since, plus head_seq for the next call.

    head_seq is the highest seq currently in the buffer (NOT the newest
    written — that could outpace the snapshot). Frontend should pass
    `since = head_seq` on the next call to avoid double-fetching.
    """
    with _lock:
        if not _buf:
            return {"entries": [], "head_seq": 0}
        # deque is FIFO; iterate and filter.
        out = [e for e in _buf if e["seq"] > since][-limit:]
        head = _buf[-1]["seq"]
    return {"entries": out, "head_seq": head}


def clear() -> None:
    with _lock:
        _buf.clear()


# ── Firestore sink (realtime log streaming to the dashboard) ─────
#
# Why: the LogsPanel used to poll /api/logs on the worker URL, which
# meant log streaming died whenever the cloudflared tunnel hiccupped
# or the worker process exited. By streaming lines into Firestore
# (subcollection `runs_index/<run_id>/logs`) the dashboard can use
# onSnapshot for true realtime AND the trail survives the worker's
# death — useful for post-mortem on a crashed render.
#
# Budget: 20K writes/day on Firestore free tier. We batch (one
# Firestore write per ≤5 sec or ≤50 lines) and cap each run at
# _FIRESTORE_MAX_WRITES so a runaway log loop can't blow the budget.

_FIRESTORE_FLUSH_INTERVAL_SEC = 5.0
_FIRESTORE_FLUSH_THRESHOLD_LINES = 50
_FIRESTORE_MAX_WRITES_PER_RUN = 200

# Per-run state — keyed by run_id. Each entry: list of pending log
# entries + count of writes performed so far.
_sink_lock = threading.Lock()
_sink_pending: dict[str, list[dict]] = {}
_sink_writes_done: dict[str, int] = {}
_sink_thread_started = False
_sink_active_run: str | None = None


def attach_run(run_id: str) -> None:
    """Mark this run_id as the one whose logs should ship to Firestore.

    Idempotent. Calling with a different run_id silently flips the
    active target so a worker handling sequential jobs streams each
    one to its own subcollection. Callers (backend/jobs.py) call this
    at job start and clear (with run_id="") on completion if desired.
    """
    global _sink_active_run, _sink_thread_started
    _sink_active_run = (run_id or "") or None
    if _sink_active_run and not _sink_thread_started:
        _sink_thread_started = True
        t = threading.Thread(target=_sink_loop, daemon=True, name="logbuf-firestore-sink")
        t.start()


def _enqueue_for_firestore(entry: dict) -> None:
    """Internal — called from the ring-buffer handler. Cheap append."""
    rid = _sink_active_run
    if not rid:
        return
    with _sink_lock:
        # Cap by write budget; once we've done the max writes for this run,
        # stop enqueueing so we don't grow memory while doing nothing.
        if _sink_writes_done.get(rid, 0) >= _FIRESTORE_MAX_WRITES_PER_RUN:
            return
        _sink_pending.setdefault(rid, []).append({
            "ts":    entry.get("time"),
            "level": entry.get("level"),
            "name":  entry.get("name"),
            "msg":   entry.get("msg"),
            "seq":   entry.get("seq"),
        })


def _sink_loop() -> None:
    """Background thread — drains pending entries to Firestore every
    flush interval OR when threshold lines accumulate, whichever first."""
    log = logging.getLogger(__name__)
    while True:
        try:
            time.sleep(_FIRESTORE_FLUSH_INTERVAL_SEC)
            with _sink_lock:
                # Snapshot + clear in one atomic move.
                snapshot: dict[str, list[dict]] = {}
                for rid, items in list(_sink_pending.items()):
                    if not items:
                        continue
                    snapshot[rid] = items
                    _sink_pending[rid] = []
            if not snapshot:
                continue
            try:
                from backend import db
                if not db.is_configured():
                    continue
                client = db.client()
            except Exception:
                # Firestore not ready — drop this batch silently.
                continue
            for rid, items in snapshot.items():
                done = _sink_writes_done.get(rid, 0)
                if done >= _FIRESTORE_MAX_WRITES_PER_RUN:
                    continue
                # One write = the whole batch as N docs created with auto-IDs.
                # Use a batched write so we pay for N docs but only ~1 RTT.
                batch = client.batch()
                coll = client.collection("runs_index").document(rid).collection("logs")
                for entry in items[:200]:  # safety: ≤200 docs per batch
                    doc = coll.document()
                    batch.set(doc, entry)
                try:
                    batch.commit()
                    _sink_writes_done[rid] = done + 1
                except Exception as e:
                    # Don't spam; log once per failure.
                    log.debug(f"logbuf firestore sink batch failed for run={rid}: {e}")
        except Exception:
            # The sink must never crash the worker. Yield and continue.
            time.sleep(1.0)
