"""
notifier.py — Best-effort Discord webhook alerting.

POSTs a colour-coded Discord embed for important events: pipeline
success/failure, YouTube upload published, R2 quota migration, etc.

Reads DISCORD_WEBHOOK_URL from either:
    1. os.environ['DISCORD_WEBHOOK_URL'] — fastest path
    2. Firestore `api_keys/DISCORD_WEBHOOK_URL` — the canonical store
       (managed via the dashboard's API Keys page)

Best-effort by design — never raises. A broken webhook should never
fail the pipeline. Includes a per-(level, title) dedup window so a
runaway loop can't spam the channel.

Usage from anywhere in backend or modules:
    from backend import notifier
    notifier.send("info", "Pipeline complete", body="3m12s · horror",
                  fields=[("video_url", url, False)])
"""
from __future__ import annotations
import os
import time
import json
import logging
import threading
from typing import Iterable

import requests

log = logging.getLogger(__name__)

# Discord embed colors (RGB ints).
_COLORS = {
    "info":    0x4ABC8A,    # green
    "success": 0x4ABC8A,
    "warn":    0xE0A82E,    # amber
    "warning": 0xE0A82E,
    "error":   0xE04D4D,    # red
    "fail":    0xE04D4D,
}

# In-process dedup so a runaway crash loop doesn't post the same error
# 200 times in a minute.
_DEDUP_WINDOW_S = 60
_dedup_lock = threading.Lock()
_dedup: dict[tuple[str, str], float] = {}


def _webhook_url() -> str:
    """Look up the webhook URL. Env var wins; falls back to Firestore."""
    v = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if v:
        return v
    try:
        from backend import db
        if not db.is_configured():
            return ""
        snap = db.client().collection("api_keys").document("DISCORD_WEBHOOK_URL").get()
        if not snap.exists:
            return ""
        d = snap.to_dict() or {}
        return str(d.get("value", "")).strip()
    except Exception as e:
        log.debug(f"notifier: Firestore lookup failed: {e}")
        return ""


def _should_send(level: str, title: str) -> bool:
    """True if this (level, title) hasn't fired in the last _DEDUP_WINDOW_S."""
    key = (level.lower(), title)
    now = time.time()
    with _dedup_lock:
        last = _dedup.get(key, 0.0)
        if (now - last) < _DEDUP_WINDOW_S:
            return False
        _dedup[key] = now
    return True


def send(
    level: str,
    title: str,
    body: str = "",
    fields: Iterable[tuple[str, str, bool]] | None = None,
    url: str | None = None,
) -> bool:
    """Post one Discord embed. Returns True on success, False on any
    failure (including config missing — silent so callers don't care).

    `level`  — info | warn | error (case-insensitive)
    `title`  — embed header (under ~256 chars)
    `body`   — main description (under ~2000 chars; auto-truncated)
    `fields` — iterable of (name, value, inline). Each value < 1024 chars.
    `url`    — clickable link on the title (use for YouTube URLs etc.)
    """
    webhook = _webhook_url()
    if not webhook:
        return False
    if not _should_send(level, title):
        log.debug(f"notifier: deduped {level}/{title}")
        return False

    color = _COLORS.get(level.lower(), 0x808080)
    embed: dict = {
        "title": title[:256],
        "description": (body or "")[:1900],
        "color": color,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    if url:
        embed["url"] = url
    if fields:
        embed["fields"] = [
            {"name": str(n)[:256], "value": str(v)[:1024], "inline": bool(inl)}
            for (n, v, inl) in fields
        ]
    # Identify which backend posted this — useful when multiple workers run.
    try:
        from backend import registry
        embed["footer"] = {"text": f"yt-agent · {registry.INSTANCE_LABEL or registry.INSTANCE_ID}"}
    except Exception:
        embed["footer"] = {"text": "yt-agent"}

    try:
        r = requests.post(
            webhook,
            json={"embeds": [embed]},
            timeout=10,
            headers={"Content-Type": "application/json"},
        )
        if r.status_code >= 300:
            log.warning(f"notifier: Discord POST {r.status_code} — {r.text[:200]}")
            return False
        return True
    except Exception as e:
        log.warning(f"notifier: Discord POST failed: {e}")
        return False


# ── Convenience wrappers ────────────────────────────────────
def info(title: str, body: str = "", **kw) -> bool:
    return send("info", title, body, **kw)


def warn(title: str, body: str = "", **kw) -> bool:
    return send("warn", title, body, **kw)


def error(title: str, body: str = "", **kw) -> bool:
    return send("error", title, body, **kw)


# ── Persistent error reporting ────────────────────────────────────
#
# Discord alerts are great for "look at this now" notifications but
# they're ephemeral, deduped, and impossible to query later. The
# /health page needs a paginated error log. So every fatal-ish event
# also writes a doc to Firestore `errors/<auto-id>` with the full
# traceback + context. The cleanup workflow prunes entries > 30 days.

def report_error(
    err: BaseException | str,
    *,
    title: str | None = None,
    run_id: str | None = None,
    req_id: str | None = None,
    level: str = "error",
    extra: dict | None = None,
    fire_discord: bool = True,
) -> bool:
    """
    Persist an error to Firestore + (optionally) fire a Discord embed.

    `err` may be an Exception (we capture class + message + traceback)
    or a plain string (just the message).

    Returns True on at least one successful sink (Firestore OR Discord),
    False if both failed. Best-effort overall — never raises.
    """
    import traceback as _tb
    cls = ""
    msg = ""
    tb = ""
    if isinstance(err, BaseException):
        cls = err.__class__.__name__
        msg = str(err)
        try:
            tb = "".join(_tb.format_exception(type(err), err, err.__traceback__))
        except Exception:
            tb = ""
    else:
        msg = str(err)

    auto_title = title or (f"{cls}: {msg[:80]}" if cls else msg[:120]) or "(unknown error)"

    # 1) Firestore sink (the source of truth for the /health page).
    firestore_ok = False
    try:
        from backend import db
        if db.is_configured():
            doc = {
                "ts":           time.time(),
                "level":        level,
                "class":        cls,
                "msg":          msg[:2000],
                "traceback":    tb[:8000] if tb else "",
                "run_id":       run_id or "",
                "req_id":       req_id or "",
                "worker_label": os.getenv("INSTANCE_LABEL") or "",
                "worker_id":    os.getenv("INSTANCE_ID") or "",
                "extra":        (extra or {}),
            }
            db.client().collection("errors").document().set(doc)
            firestore_ok = True
    except Exception as _e:
        log.debug(f"report_error firestore sink failed: {_e}")

    # 2) Discord embed (the "look at this now" channel).
    discord_ok = False
    if fire_discord:
        fields = []
        if run_id: fields.append(("run_id", run_id, True))
        if req_id: fields.append(("req_id", req_id, True))
        worker = os.getenv("INSTANCE_LABEL")
        if worker: fields.append(("worker", worker, True))
        # First 1000 chars of traceback in the body for context.
        body = msg
        if tb:
            body += "\n\n```\n" + tb[-1200:] + "\n```"
        try:
            discord_ok = send(level if level in _COLORS else "error",
                              title=("❌ " + auto_title)[:240],
                              body=body[:3500],
                              fields=fields)
        except Exception as _e:
            log.debug(f"report_error discord sink failed: {_e}")

    return firestore_ok or discord_ok
