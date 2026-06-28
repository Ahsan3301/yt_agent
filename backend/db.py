"""
db.py — Firestore client wrapper.

Reads the service-account JSON from one of two env vars:
  GOOGLE_APPLICATION_CREDENTIALS_JSON      — raw JSON (Colab + HF Space)
  GOOGLE_APPLICATION_CREDENTIALS_JSON_B64  — base64-encoded JSON (Kaggle)

The base64 variant exists because Kaggle's Secrets UI truncates plain
string values around 150 characters, mangling the multi-line private_key
field. Base64-encoded the credential is a single line of [A-Za-z0-9+/=]
which Kaggle stores cleanly. Either env var works on any platform.

Writes the decoded credential to a tempfile, points the Firebase Admin
SDK at it, and exposes a lazy singleton client.

Lazy on purpose: the import path runs in environments where Firestore
isn't configured yet (local dev, HF Space pre-cutover) and we don't want
to hard-fail at module load. Callers must check `is_configured()` first
OR catch the RuntimeError from `client()`.
"""
from __future__ import annotations
import os
import json
import base64
import logging
import tempfile
import threading

log = logging.getLogger(__name__)

_SERVICE_ACCOUNT_ENV     = "GOOGLE_APPLICATION_CREDENTIALS_JSON"
_SERVICE_ACCOUNT_B64_ENV = "GOOGLE_APPLICATION_CREDENTIALS_JSON_B64"


def _load_raw_credential() -> str:
    """Return the decoded JSON string, looking in both env vars.

    Priority: _B64 wins if both are set (so a partial truncated raw value
    can't clobber a working base64 one). Returns "" if neither is set.
    """
    b64 = os.getenv(_SERVICE_ACCOUNT_B64_ENV, "").strip()
    if b64:
        try:
            # Some UIs strip padding; pad back to a multiple of 4.
            padded = b64 + "=" * ((4 - len(b64) % 4) % 4)
            return base64.b64decode(padded).decode("utf-8")
        except Exception as e:
            raise RuntimeError(
                f"{_SERVICE_ACCOUNT_B64_ENV} set but base64-decode failed: {e}"
            )
    return os.getenv(_SERVICE_ACCOUNT_ENV, "").strip()

_lock = threading.Lock()
_client = None
_init_attempted = False


def is_configured() -> bool:
    """True if either credential env var is set. Doesn't actually init
    the client — call client() for that."""
    return bool(
        os.getenv(_SERVICE_ACCOUNT_ENV, "").strip()
        or os.getenv(_SERVICE_ACCOUNT_B64_ENV, "").strip()
    )


def client():
    """Return the lazily-initialised Firestore client. Raises
    RuntimeError if creds aren't configured or the SDK can't authenticate."""
    global _client, _init_attempted
    if _client is not None:
        return _client
    with _lock:
        if _client is not None:
            return _client
        if _init_attempted:
            # Don't keep retrying a broken setup every request.
            raise RuntimeError("Firestore init previously failed; check service account env var")
        _init_attempted = True

        raw = _load_raw_credential()
        if not raw:
            raise RuntimeError(
                f"{_SERVICE_ACCOUNT_ENV} or {_SERVICE_ACCOUNT_B64_ENV} not set "
                f"— Firestore can't initialise"
            )
        # Validate it's parseable JSON before writing to disk.
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"credential JSON parse failed at {e.pos} chars: {e.msg}. "
                f"If you're on Kaggle, paste the value as base64 into "
                f"{_SERVICE_ACCOUNT_B64_ENV} instead — Kaggle's UI truncates "
                f"plain text values around 150 chars."
            )

        # Some pasted credentials have literal \n in the private_key field
        # instead of real newlines (happens when copying through chat UIs).
        # Heal that here so the SDK can parse the PEM.
        pk = payload.get("private_key", "")
        if pk and "\\n" in pk and "\n" not in pk:
            payload["private_key"] = pk.replace("\\n", "\n")

        # Write to a tempfile and point GOOGLE_APPLICATION_CREDENTIALS at it.
        tmp = tempfile.NamedTemporaryFile(
            "w", delete=False, suffix=".json", prefix="firebase-"
        )
        json.dump(payload, tmp)
        tmp.close()
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = tmp.name

        try:
            import firebase_admin
            from firebase_admin import credentials, firestore
            if not firebase_admin._apps:
                firebase_admin.initialize_app(credentials.Certificate(tmp.name))
            _client = firestore.client()
            log.info(f"firestore: connected (project={payload.get('project_id')})")
            return _client
        except Exception as e:
            raise RuntimeError(f"firebase-admin init failed: {e}")


def server_timestamp():
    """Sentinel for SERVER_TIMESTAMP. Cheap helper so callers don't need
    to import firestore directly."""
    from firebase_admin import firestore
    return firestore.SERVER_TIMESTAMP
