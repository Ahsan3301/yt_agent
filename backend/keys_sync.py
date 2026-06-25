"""
keys_sync.py — Centralised API-key distribution via Hostinger.

The dashboard's API Keys page writes a single `keys.json` file to
Hostinger (under `.private/`, blocked from public HTTP). Every backend
(Colab GPU, HF Space CPU) pulls this file on startup and populates its
`os.environ`. Result: you set keys in ONE place, all backends use them.

What's a "managed key"?  Any of the API-key field names listed in
MANAGED_KEYS below. We deliberately don't manage FTP_* / PUBLIC_*
because those are the bootstrap minimum each backend already has.
"""
import os
import logging
from backend import storage

log = logging.getLogger(__name__)

# Keys that are safe to manage via the central store. (Bootstrap-required
# keys like FTP_HOST stay platform-local so a backend can boot without
# the keys file existing yet.)
MANAGED_KEYS = [
    "GROQ_API_KEY",
    "NVIDIA_NIM_API_KEY",
    "SHUTTERSTOCK_API_TOKEN",
    "SHUTTERSTOCK_CLIENT_ID",
    "SHUTTERSTOCK_CLIENT_SECRET",
    "PEXELS_API_KEY",
    "PIXABAY_API_KEY",
    "COVERR_API_KEY",
]


def pull_into_env(override: bool = True) -> dict:
    """
    Fetch keys.json from Hostinger and populate os.environ.

    override=True (default): the central store wins over any pre-set env
    var. This is the right behaviour on Colab/HF where the platform-level
    secrets are minimal and the central store should be authoritative.
    """
    keys = storage.download_keys()
    if not keys:
        log.info("keys_sync: no central keys.json (or empty) — using local env only")
        return {}
    applied = {}
    for name in MANAGED_KEYS:
        value = keys.get(name)
        if not value:
            continue
        if override or not os.environ.get(name):
            os.environ[name] = str(value)
            applied[name] = "*" * 8  # don't log the value itself
    if applied:
        log.info(f"keys_sync: applied {len(applied)} key(s) from central store: "
                 + ", ".join(applied.keys()))
    return applied


def push_from_payload(updates: dict) -> dict:
    """
    Merge `updates` into the existing keys.json on Hostinger and upload.
    Used by the dashboard's PUT /api/keys to broadcast changes.

    `updates` values of None (or empty string) DELETE that key from the
    central store. Returns the new full dict.
    """
    current = storage.download_keys()
    for name, value in (updates or {}).items():
        if name not in MANAGED_KEYS:
            continue
        if value in (None, ""):
            current.pop(name, None)
            os.environ.pop(name, None)
        else:
            current[name] = str(value)
            os.environ[name] = str(value)
    storage.upload_keys(current)
    return current


def central_status() -> dict[str, dict]:
    """
    Returns each managed key's "set/unset" status as seen in the central
    store right now (independent of os.environ). Used by the dashboard's
    GET /api/keys to render the masked list.
    """
    keys = storage.download_keys()
    out = {}
    for name in MANAGED_KEYS:
        v = keys.get(name) or ""
        out[name] = {
            "set": bool(v),
            "masked": _mask(v),
            "managed": True,
        }
    return out


def _mask(v: str) -> str:
    if not v:
        return ""
    if len(v) <= 8:
        return "*" * len(v)
    return v[:4] + "*" * (len(v) - 8) + v[-4:]
