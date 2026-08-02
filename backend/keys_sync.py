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
    "YOUTUBE_API_KEY",           # Data API v3 — competitor keyword lookup in
                                 # seo_borrower (search.list + videos.list).
                                 # Was missing here, so a key saved in the
                                 # dashboard never reached the worker env and
                                 # the feature stayed silently off.
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


def _shadow_id(user_id: str) -> str:
    """Composite id for the per-user shadow of the api_keys blob.
    Matches web/app/api/keys/route.ts::_shadowId byte-for-byte."""
    return f"{user_id}__api_keys"


# Operator-supplied keys shared by every tenant.
#
# Deliberately a SEPARATE document from the founder's own blob at
# settings/api_keys. Conflating them would mean "the operator's
# personal credentials" and "the credentials customers are entitled to
# use" are the same thing, so there'd be no way to give customers
# access to a pooled Groq key without also handing them whatever else
# the founder happens to have configured.
_POOL_DOC_ID = "platform_pool__api_keys"

FOUNDER_USER_ID = "ufounder0000000"


def _blob_of(c, doc_id: str) -> dict[str, str]:
    """Read one settings/<doc_id> blob into a flat {name: value} dict.

    PocketBase stores the JSON column as either a native dict or a
    string depending on how it was written, so both shapes are handled.
    """
    try:
        snap = c.collection("settings").document(doc_id).get()
        if not snap.exists:
            return {}
        blob = (snap.to_dict() or {}).get("data") or {}
        if isinstance(blob, str):
            import json as _json
            try:
                blob = _json.loads(blob)
            except Exception:
                return {}
        if not isinstance(blob, dict):
            return {}
        return {k: str(v) for k, v in blob.items() if isinstance(v, str) and v}
    except Exception as e:
        log.warning(f"keys_sync: read of settings/{doc_id} failed: {e}")
        return {}


def _read_all(user_id: str | None = None) -> dict[str, str]:
    """Return {key_name: value} for this tenant.

    Resolution order (later wins):

        1. Platform pool  settings/platform_pool__api_keys
        2. Tenant's own   settings/{user_id}__api_keys

    The pool is the operator's shared credentials, priced into the
    subscription. Merging it UNDERNEATH the tenant's own keys is what
    makes the product usable by a non-technical customer: previously a
    user with no shadow document got {} and their render simply had no
    AI providers, so before publishing one video they had to sign up
    for NVIDIA NIM, HuggingFace, Cloudflare, OpenRouter, Stable Horde,
    Pexels and an S3 bucket. Now they inherit working defaults and only
    connect YouTube.

    Merging per-key (rather than picking one source wholesale) keeps
    bring-your-own viable: a tenant who sets only GROQ_API_KEY gets
    their Groq key plus pooled everything-else, which is what a power
    user moving one provider at a time expects.

    The founder additionally falls through to the legacy singleton at
    settings/api_keys so the original single-tenant setup keeps working
    untouched.
    """
    if not db.is_configured():
        return {}
    try:
        c = db.client()

        if user_id:
            pool = _blob_of(c, _POOL_DOC_ID)
            own = _blob_of(c, _shadow_id(user_id))
            merged = {**pool, **own}
            if merged:
                if pool and own:
                    log.info(f"keys_sync: {len(own)} tenant key(s) over "
                             f"{len(pool)} pooled key(s)")
                elif pool:
                    log.info(f"keys_sync: using {len(pool)} pooled platform key(s)")
                return merged
            # Nothing for this tenant and nothing pooled. The founder
            # continues to the legacy singleton below; anyone else gets
            # an empty set, which surfaces as a clear "no providers
            # configured" failure rather than silently borrowing
            # someone else's credentials.
            if user_id != FOUNDER_USER_ID:
                return {}
        # Legacy singleton path — founder only, or no user context.
        snap = c.collection("settings").document(_BLOB_DOC_ID).get()
        if snap.exists:
            data = snap.to_dict() or {}
            blob = data.get("data") or {}
            if isinstance(blob, str):
                try:
                    import json as _json
                    blob = _json.loads(blob)
                except Exception:
                    blob = {}
            if isinstance(blob, dict):
                return {k: str(v) for k, v in blob.items() if isinstance(v, str) and v}
        # Legacy per-key fallback.
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


def pull_into_env(override: bool = True, user_id: str | None = None) -> dict:
    """
    Fetch keys from Firestore and populate os.environ.

    override=True (default): the central store wins over any pre-set env
    var. Right behaviour on Colab/HF where the platform-level secrets are
    minimal and the central store should be authoritative.

    user_id: resolves through _read_all — the operator's shared pool
    merged underneath this tenant's own keys, so a customer who has
    configured nothing still renders on pooled credentials while a
    tenant who supplies their own overrides the pool per key.
    """
    keys = _read_all(user_id=user_id)
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


def get_key(name: str, user_id: str | None = None) -> str | None:
    """Read a single key straight from the central store.

    pull_into_env is the normal path — it runs before each job and puts
    every MANAGED_KEYS entry into os.environ. This is the direct lookup
    for callers that may run outside that flow, so a missing
    pull_into_env doesn't silently disable a feature. Resolves through
    the same pool-then-tenant merge, so an unconfigured customer still
    gets the operator's pooled credential.

    Returns None (never raises) — every caller treats an absent key as
    "feature off", not as an error.
    """
    if not name:
        return None
    try:
        v = (_read_all(user_id=user_id) or {}).get(name)
        if v and str(v).strip():
            return str(v).strip()
        # _read_all only consults the platform pool when a user_id is
        # supplied — without one it falls through to the legacy
        # singleton, which does not carry pooled credentials. That made
        # this fallback useless for exactly the keys it exists to serve:
        # get_key("YOUTUBE_API_KEY") returned None while the key sat in
        # the pool. A fallback that cannot reach the pool is not a
        # fallback.
        if not user_id:
            try:
                blob = _blob_of(db.client(), _POOL_DOC_ID)
                pv = (blob or {}).get(name)
                if pv and str(pv).strip():
                    return str(pv).strip()
            except Exception:
                pass
        return None
    except Exception as e:
        log.debug(f"keys_sync.get_key({name}) failed: {e}")
        return None


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
