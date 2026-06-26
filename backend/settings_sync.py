"""
settings_sync.py — Pull settings from Firestore into the local
config/settings.json so a fresh container boots with the user's last
saved knobs (channel, voice, video tone, music, etc.) instead of
defaults.

Called once from server.py startup hook, BEFORE modules.config._S is
read by other modules. Save direction is handled inside
modules.config.save_settings (lazy push to remote).

Document: settings/default { data: { ...full settings dict... } }
"""
from __future__ import annotations
import logging
from pathlib import Path

from backend import db

log = logging.getLogger(__name__)

LOCAL_SETTINGS_PATH = Path("config/settings.json")
SETTINGS_DOC = ("settings", "default")


def pull_into_local() -> bool:
    """Fetch settings from Firestore and overwrite local file.

    Returns True if the remote had data and we wrote it locally.
    False if storage isn't configured / empty / unreadable — caller
    falls back to DEFAULT_SETTINGS in modules.config.
    """
    if not db.is_configured():
        log.info("settings_sync: Firestore not configured — keeping local defaults")
        return False
    try:
        snap = db.client().collection(SETTINGS_DOC[0]).document(SETTINGS_DOC[1]).get()
    except Exception as e:
        log.warning(f"settings_sync: Firestore read failed: {e}")
        return False
    if not snap.exists:
        log.info("settings_sync: no remote settings doc yet — using local defaults")
        return False
    data = (snap.to_dict() or {}).get("data")
    if not isinstance(data, dict) or not data:
        log.info("settings_sync: remote doc has no data — using local defaults")
        return False
    try:
        import json
        import os as _os
        LOCAL_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = LOCAL_SETTINGS_PATH.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        _os.replace(tmp, LOCAL_SETTINGS_PATH)
        log.info(f"settings_sync: hydrated local settings.json from Firestore ({len(data)} top-level keys)")
        return True
    except Exception as e:
        log.warning(f"settings_sync write failed: {e}")
        return False


def push_from_local() -> bool:
    """Force-push the current local settings.json to Firestore.
    Called by modules.config.save_settings after an atomic write."""
    if not db.is_configured():
        return False
    if not LOCAL_SETTINGS_PATH.exists():
        return False
    try:
        import json
        with open(LOCAL_SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        db.client().collection(SETTINGS_DOC[0]).document(SETTINGS_DOC[1]).set(
            {"data": data, "updated_at": db.server_timestamp()}, merge=False
        )
        return True
    except Exception as e:
        log.warning(f"settings_sync push failed: {e}")
        return False
