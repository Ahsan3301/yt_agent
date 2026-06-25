"""
settings_sync.py — Pull settings.json from R2/SFTP into the local
config/settings.json so a fresh container boots with the user's last
saved knobs (channel, voice, video tone, music, etc.) instead of
defaults.

Called once from server.py startup hook, BEFORE
modules.config._S is read by other modules. Save direction is handled
inside modules.config.save_settings (lazy push to remote).
"""
from __future__ import annotations
import logging
from pathlib import Path

from backend import storage

log = logging.getLogger(__name__)

LOCAL_SETTINGS_PATH = Path("config/settings.json")


def pull_into_local() -> bool:
    """Fetch the shared settings.json and overwrite the local file.

    Returns True if the remote had something and we wrote it locally.
    False if the remote is empty, unreachable, or storage isn't
    configured — in which case modules.config falls back to its
    DEFAULT_SETTINGS as before.
    """
    if not storage.is_configured():
        log.info("settings_sync: storage not configured — keeping local defaults")
        return False
    data = storage.download_settings()
    if not data:
        log.info("settings_sync: no remote settings.json yet — using local defaults")
        return False
    try:
        import json
        LOCAL_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = LOCAL_SETTINGS_PATH.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        import os as _os
        _os.replace(tmp, LOCAL_SETTINGS_PATH)
        log.info(f"settings_sync: hydrated local settings.json from remote ({len(data)} keys)")
        return True
    except Exception as e:
        log.warning(f"settings_sync write failed: {e}")
        return False


def push_from_local() -> bool:
    """Force-push the current local settings.json to remote. Used by
    modules.config.save_settings after an atomic write."""
    if not storage.is_configured():
        return False
    if not LOCAL_SETTINGS_PATH.exists():
        return False
    try:
        import json
        with open(LOCAL_SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return storage.upload_settings(data)
    except Exception as e:
        log.warning(f"settings_sync push failed: {e}")
        return False
