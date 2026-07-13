"""
keys_sync.py — Centralised API-key distribution via Firestore.

The dashboard's API Keys page writes per-key documents to the
`api_keys` Firestore collection. Every backend (Colab GPU, HF Space CPU)
pulls them on startup and populates its `os.environ`. Result: you set
keys in ONE place, all backends use them.

Document layout:
    api_keys/<KEY_NAME> {
      value:      str,
      updated_at: Timestamp,
    }

What's a "managed key"? Any of the API-key field names listed in
MANAGED_KEYS below. We deliberately don't manage R2_* / SFTP_* / etc.
because those are the bootstrap minimum each backend already has via
its platform secret store.
"""
import os
import logging
from backend import db

log = logging.getLogger(__name__)

# Keys that are safe to manage via the central store.
#
# Originally we excluded R2_* / SFTP_* because they were bootstrap-required.
# But after the Firestore migration, Firestore itself is the boot dependency —
# once a worker can reach Firestore it can pull every other credential. This
# matters most on Kaggle, where the secrets-panel UI detaches secrets on each
# 'kaggle kernels push' new-version — making R2 credentials painful to keep
# attached. Now R2/SFTP live in Firestore too; the only platform-local secret
# a worker needs is GOOGLE_APPLICATION_CREDENTIALS_JSON_B64 (or _JSON).
MANAGED_KEYS = [
    "GROQ_API_KEY",
    # Multi-key pools (audit fix #12, 2026-07-13). JSON array of keys —
    # rotate on 401/403/429 with 5-min cooldown per bad key. Falls back
    # to the singular env above when unset. Same shape as
    # CLOUDFLARE_ACCOUNTS_JSON but simpler: just a list of strings.
    "GROQ_API_KEYS_JSON",
    "NVIDIA_NIM_API_KEY",
    "NVIDIA_NIM_API_KEYS_JSON",
    "SHUTTERSTOCK_API_TOKEN",
    "SHUTTERSTOCK_CLIENT_ID",
    "SHUTTERSTOCK_CLIENT_SECRET",
    "PEXELS_API_KEY",
    "PIXABAY_API_KEY",
    "COVERR_API_KEY",
    "HF_TOKEN",                  # HuggingFace Inference API — free SDXL fallback
    "STABLEHORDE_API_KEY",       # Stable Horde priority key — free registered users
                                 # get faster queue than the '0000000000' anon key.
                                 # Sign up: https://stablehorde.net/register
    "CLOUDFLARE_ACCOUNT_ID",     # Workers AI — legacy single-account (still works)
    "CLOUDFLARE_API_TOKEN",      # Workers AI Read scope only, no other perms needed
    "CLOUDFLARE_ACCOUNTS_JSON",  # Multi-account pool for klein-9b rotation:
                                 #   [{"label":..,"account_id":..,"api_token":..}, ...]
                                 # ~60 imgs/day free per account; rotates on 429-quota.
    "OPENROUTER_API_KEY",        # Second-layer LLM fallback (llama-3.3 free tier)
    "OPENROUTER_API_KEYS_JSON",  # Multi-key rotation (see NVIDIA_NIM_API_KEYS_JSON note)
    "OPENROUTER_MODEL",          # Optional model override (default llama-3.3-70b-instruct:free)
    "DISCORD_WEBHOOK_URL",       # alerting channel for renders + cleanup
    "YOUTUBE_REFRESH_TOKEN",     # auto-publish to YouTube
    "RENDER_TRIGGER_KEY",        # shared secret for GitHub Actions → Vercel
    # Storage credentials — moved here so Kaggle only needs one platform
    # secret (the Firebase service account).
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_URL",
    "SFTP_HOST",
    "SFTP_PORT",
    "SFTP_USER",
    "SFTP_PASS",
    "SFTP_BASE_DIR",
    "PUBLIC_BASE_URL",
]


_BLOB_DOC_ID = "api_keys"


def _read_all() -> dict[str, str]:
    """Return {key_name: value} from the central store.

    Storage model: ONE record in the `settings` collection with id
    "api_keys" and a `data` JSON field holding the full {KEY: value}
    map. This sidesteps PB's 15-char doc-id requirement (and the
    hash-collision read bug it caused for per-key records).
    """
    if not db.is_configured():
        return {}
    try:
        c = db.client()
        # New blob path.
        snap = c.collection("settings").document(_BLOB_DOC_ID).get()
        if snap.exists:
            data = snap.to_dict() or {}
            blob = data.get("data") or {}
            if isinstance(blob, dict):
                return {k: str(v) for k, v in blob.items() if isinstance(v, str) and v}
        # Legacy fallback — old per-key records (still works on
        # Firestore-shape deploys where doc ids ARE the key names).
        out: dict[str, str] = {}
        for s in c.collection("api_keys").stream():
            d = s.to_dict() or {}
            v = d.get("value")
            if v:
                out[s.id] = str(v)
        return out
    except Exception as e:
        log.warning(f"keys_sync: central store read failed: {e}")
        return {}


def pull_into_env(override: bool = True) -> dict:
    """
    Fetch keys from Firestore and populate os.environ.

    override=True (default): the central store wins over any pre-set env
    var. Right behaviour on Colab/HF where the platform-level secrets are
    minimal and the central store should be authoritative.
    """
    keys = _read_all()
    if not keys:
        log.info("keys_sync: no central keys (or empty) — using local env only")
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
    Merge `updates` into the Firestore api_keys collection.
    Used by the dashboard's PUT /api/keys to broadcast changes.

    `updates` values of None (or empty string) DELETE that key from the
    central store. Returns the new full dict.
    """
    if not db.is_configured():
        raise RuntimeError("DB not configured")
    c = db.client()
    current = _read_all()
    for name, value in (updates or {}).items():
        if name not in MANAGED_KEYS:
            continue
        if value in (None, ""):
            current.pop(name, None)
            os.environ.pop(name, None)
        else:
            current[name] = str(value)
            os.environ[name] = str(value)
    # Single write to the blob — atomic on PB; effectively atomic on
    # Firestore for the small payload size.
    c.collection("settings").document(_BLOB_DOC_ID).set(
        {"data": current, "updated_at": db.server_timestamp()},
        merge=False,
    )
    return current


def central_status() -> dict[str, dict]:
    """
    Returns each managed key's "set/unset" status as seen in the central
    store right now (independent of os.environ). Used by the dashboard's
    GET /api/keys to render the masked list.
    """
    keys = _read_all()
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
