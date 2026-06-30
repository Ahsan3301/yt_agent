"""
db.py — Database client wrapper. Firestore or Pocketbase.

Backend selected by DB_BACKEND env var:
  unset / "firestore"  → Google Cloud Firestore (legacy default)
  "pocketbase"         → self-hosted Pocketbase (Coolify deploys)

Both expose the same `client()` shape — modules that do
`from backend import db; c = db.client(); c.collection("jobs")...`
work unchanged on either backend.

────── Firestore path (legacy) ──────
Reads the service-account JSON from one of two env vars:
  GOOGLE_APPLICATION_CREDENTIALS_JSON      — raw JSON (Colab + HF Space)
  GOOGLE_APPLICATION_CREDENTIALS_JSON_B64  — base64-encoded JSON (Kaggle)

The base64 variant exists because Kaggle's Secrets UI truncates plain
string values around 150 characters, mangling the multi-line private_key
field. Base64-encoded the credential is a single line of [A-Za-z0-9+/=]
which Kaggle stores cleanly. Either env var works on any platform.

────── Pocketbase path ──────
Reads:
  PB_URL_INTERNAL  (preferred — docker network hostname inside Coolify)
  PB_URL           (fallback — public domain, used when running outside
                    the Coolify stack)
  PB_SERVER_TOKEN  (service token — bypasses access rules)

Lazy on purpose: the import path runs in environments where neither
backend is configured yet (local dev, HF Space pre-cutover) and we
don't want to hard-fail at module load. Callers must check
`is_configured()` first OR catch the RuntimeError from `client()`.
"""
from __future__ import annotations
import os
import json
import base64
import logging
import tempfile
import threading

log = logging.getLogger(__name__)


_BACKEND = (os.getenv("DB_BACKEND") or "firestore").strip().lower()

# ── Firestore-path env vars ──────────────────────────────────────
_SERVICE_ACCOUNT_ENV     = "GOOGLE_APPLICATION_CREDENTIALS_JSON"
_SERVICE_ACCOUNT_B64_ENV = "GOOGLE_APPLICATION_CREDENTIALS_JSON_B64"

# ── Pocketbase-path env vars ─────────────────────────────────────
_PB_URL_ENV      = "PB_URL"
_PB_URL_INT_ENV  = "PB_URL_INTERNAL"
_PB_TOKEN_ENV    = "PB_SERVER_TOKEN"


def _load_raw_firestore_credential() -> str:
    b64 = os.getenv(_SERVICE_ACCOUNT_B64_ENV, "").strip()
    if b64:
        try:
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
    """True if the active backend's env vars are set. Doesn't init
    the client — call client() for that."""
    if _BACKEND == "pocketbase":
        has_url = bool((os.getenv(_PB_URL_INT_ENV) or os.getenv(_PB_URL_ENV) or "").strip())
        has_admin = bool(
            os.getenv("POCKETBASE_ADMIN_EMAIL", "").strip()
            and os.getenv("POCKETBASE_ADMIN_PASSWORD", "").strip()
        )
        has_token = bool(os.getenv(_PB_TOKEN_ENV, "").strip())
        return has_url and (has_admin or has_token)
    return bool(
        os.getenv(_SERVICE_ACCOUNT_ENV, "").strip()
        or os.getenv(_SERVICE_ACCOUNT_B64_ENV, "").strip()
    )


def backend() -> str:
    """Return the active backend name. Used by callers that need to
    branch on Firestore-specific semantics (rare)."""
    return _BACKEND


def client():
    """Return the lazily-initialised DB client. Raises RuntimeError if
    creds aren't configured or the SDK can't authenticate."""
    global _client, _init_attempted
    if _client is not None:
        return _client
    with _lock:
        if _client is not None:
            return _client
        if _init_attempted:
            raise RuntimeError(
                f"DB init previously failed; check {_BACKEND} env vars"
            )
        _init_attempted = True

        if _BACKEND == "pocketbase":
            return _init_pocketbase()
        return _init_firestore()


def _init_pocketbase():
    global _client
    url = (os.getenv(_PB_URL_INT_ENV) or os.getenv(_PB_URL_ENV) or "").strip()
    token = os.getenv(_PB_TOKEN_ENV, "").strip()
    if not url:
        raise RuntimeError(
            f"DB_BACKEND=pocketbase but {_PB_URL_INT_ENV}/{_PB_URL_ENV} not set"
        )
    # Token OR admin creds — PB has no static service-token concept yet,
    # so admin creds are the practical path; PB_SERVER_TOKEN kept for
    # future API parity.
    has_admin = bool(
        os.getenv("POCKETBASE_ADMIN_EMAIL", "").strip()
        and os.getenv("POCKETBASE_ADMIN_PASSWORD", "").strip()
    )
    if not token and not has_admin:
        raise RuntimeError(
            "DB_BACKEND=pocketbase needs either PB_SERVER_TOKEN OR "
            "POCKETBASE_ADMIN_EMAIL + POCKETBASE_ADMIN_PASSWORD"
        )
    from backend.db_pocketbase import PocketBaseClient
    _client = PocketBaseClient(url=url, token=token)
    log.info("db: connected to Pocketbase (%s)", url)
    return _client


def _init_firestore():
    global _client
    raw = _load_raw_firestore_credential()
    if not raw:
        raise RuntimeError(
            f"{_SERVICE_ACCOUNT_ENV} or {_SERVICE_ACCOUNT_B64_ENV} not set "
            f"— Firestore can't initialise"
        )
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"credential JSON parse failed at {e.pos} chars: {e.msg}. "
            f"If you're on Kaggle, paste the value as base64 into "
            f"{_SERVICE_ACCOUNT_B64_ENV} instead — Kaggle's UI truncates "
            f"plain text values around 150 chars."
        )

    pk = payload.get("private_key", "")
    if pk and "\\n" in pk and "\n" not in pk:
        payload["private_key"] = pk.replace("\\n", "\n")

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
        log.info("firestore: connected (project=%s)", payload.get("project_id"))
        return _client
    except Exception as e:
        raise RuntimeError(f"firebase-admin init failed: {e}")


def server_timestamp():
    """Sentinel for SERVER_TIMESTAMP. Cheap helper so callers don't need
    to import firestore directly. Backend-aware — returns the sentinel
    each backend recognises."""
    if _BACKEND == "pocketbase":
        from backend.db_pocketbase import SERVER_TIMESTAMP
        return SERVER_TIMESTAMP
    from firebase_admin import firestore
    return firestore.SERVER_TIMESTAMP
