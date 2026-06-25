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
