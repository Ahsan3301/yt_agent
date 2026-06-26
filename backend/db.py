"""
db.py — Firestore client wrapper.

Reads the service-account JSON from one env var
(GOOGLE_APPLICATION_CREDENTIALS_JSON), writes it to a tempfile, points
the Firebase Admin SDK at it, and exposes a lazy singleton client.

Lazy on purpose: the import path runs in environments where Firestore
isn't configured yet (local dev, HF Space pre-cutover) and we don't want
to hard-fail at module load. Callers must check `is_configured()` first
OR catch the RuntimeError from `client()`.

Why a single env var: the service account JSON contains a PEM-formatted
private key with literal newlines that get mangled by line-by-line env
var pasting in many UIs. HF Space + Colab both support multi-line
secrets so we just paste the file contents as-is.
"""
from __future__ import annotations
import os
import json
import logging
import tempfile
import threading

log = logging.getLogger(__name__)

_SERVICE_ACCOUNT_ENV = "GOOGLE_APPLICATION_CREDENTIALS_JSON"

_lock = threading.Lock()
_client = None
_init_attempted = False


def is_configured() -> bool:
    """True if the service-account env var is set. Doesn't actually
    init the client — call client() for that."""
    return bool(os.getenv(_SERVICE_ACCOUNT_ENV, "").strip())


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

        raw = os.getenv(_SERVICE_ACCOUNT_ENV, "").strip()
        if not raw:
            raise RuntimeError(
                f"{_SERVICE_ACCOUNT_ENV} not set — Firestore can't initialise"
            )
        # Validate it's parseable JSON before writing to disk.
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"{_SERVICE_ACCOUNT_ENV} is not valid JSON: {e}"
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
