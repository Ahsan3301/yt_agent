"""
Storage provider registry.

Reads the storage_providers collection from Pocketbase, hydrates each
row into a ProviderConfig (decrypting credential fields), and caches
StorageProvider instances keyed by id.

Roles:
  - PRIMARY: exactly one provider where is_primary=true. Required.
    Upload failures raise.
  - MIRROR: 0 or 1 provider where is_mirror=true. Best-effort. Upload
    failures are logged + reported to Discord but don't fail the run.

Cache invalidation: a 30-second TTL — we re-fetch from Pocketbase if
the cache is older than that. Fast enough that a user toggling
primary/mirror in the UI takes effect within ~30 sec without us having
to wire a Pocketbase realtime subscription into the worker.

Env-var fallback: when Pocketbase is unreachable OR no providers are
defined (fresh deploy), we synthesise a single provider from the env
vars Coolify sets (S3_ENDPOINT, S3_BUCKET, etc.). This lets the first
upload work before the user has clicked through the /storage page.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

from .crypto import decrypt
from .providers.aws_s3 import AwsS3Provider
from .providers.backblaze_b2 import BackblazeB2Provider
from .providers.base import ProviderConfig, StorageProvider
from .providers.hostinger_sftp import HostingerSftpProvider
from .providers.minio import MinIOProvider
from .providers.r2 import R2Provider
from .providers.wasabi import WasabiProvider

log = logging.getLogger(__name__)


# Map kind string → provider class. Keep in sync with PROVIDER_KINDS
# in providers/base.py.
_PROVIDER_CLASSES = {
    "minio":          MinIOProvider,
    "r2":             R2Provider,
    "aws_s3":         AwsS3Provider,
    "wasabi":         WasabiProvider,
    "b2":             BackblazeB2Provider,
    "hostinger_sftp": HostingerSftpProvider,
}


# ── Cache state ─────────────────────────────────────────────────
_CACHE_TTL = 30.0
_lock = threading.Lock()
_cache_at: float = 0.0
_primary: Optional[StorageProvider] = None
_mirror: Optional[StorageProvider] = None
_all: dict[str, StorageProvider] = {}


def _build_provider(cfg: ProviderConfig) -> StorageProvider:
    cls = _PROVIDER_CLASSES.get(cfg.kind)
    if cls is None:
        raise ValueError(f"Unknown provider kind: {cfg.kind}")
    return cls(cfg)


def _hydrate_from_pb_row(row: dict) -> ProviderConfig:
    """Convert a raw Pocketbase row dict into a ProviderConfig with
    credentials decrypted."""
    def _dec(field: str) -> str:
        return decrypt(row.get(field, "")) if row.get(field) else ""

    return ProviderConfig(
        id=row.get("id") or "",
        name=row.get("name") or "",
        kind=row.get("kind") or "",
        endpoint=row.get("endpoint") or "",
        bucket=row.get("bucket") or "",
        region=row.get("region") or "auto",
        access_key_id=_dec("access_key_id"),
        secret_access_key=_dec("secret_access_key"),
        public_base=row.get("public_base") or "",
        path_style=bool(row.get("path_style", True)),
        host=row.get("host") or "",
        port=int(row.get("port") or 22),
        user=row.get("user") or "",
        password=_dec("password"),
        base_dir=row.get("base_dir") or "",
        is_primary=bool(row.get("is_primary")),
        is_mirror=bool(row.get("is_mirror")),
        enabled=bool(row.get("enabled", True)),
        extras=row.get("extras") or {},
    )


def _envvar_fallback_config() -> Optional[ProviderConfig]:
    """Synthesise a provider from env vars when no Pocketbase rows
    exist. Lets fresh deploys upload before the user has touched the
    /storage UI. Priority: S3_* → R2_* → SFTP_*."""

    # 1. Generic S3_* (this is what Coolify sets pointing at MinIO).
    if os.getenv("S3_ENDPOINT") and os.getenv("S3_BUCKET"):
        # Use S3_ENDPOINT_INTERNAL if set (docker-network hostname).
        endpoint = os.getenv("S3_ENDPOINT_INTERNAL") or os.getenv("S3_ENDPOINT")
        return ProviderConfig(
            id="env-default",
            name="Env-configured (S3_*)",
            kind="minio",  # generic s3-like; MinIO provider has the safest defaults
            endpoint=endpoint,
            bucket=os.getenv("S3_BUCKET") or "",
            access_key_id=os.getenv("S3_ACCESS_KEY_ID") or "",
            secret_access_key=os.getenv("S3_SECRET_ACCESS_KEY") or "",
            public_base=os.getenv("NEXT_PUBLIC_S3_PUBLIC_BASE") or os.getenv("S3_PUBLIC_BASE") or "",
            region=os.getenv("S3_REGION") or "us-east-1",
            path_style=True,
            is_primary=True,
            enabled=True,
        )

    # 2. Legacy R2_* (existing Vercel deployments).
    if os.getenv("R2_ACCOUNT_ID") and os.getenv("R2_ACCESS_KEY_ID"):
        account_id = os.getenv("R2_ACCOUNT_ID") or ""
        return ProviderConfig(
            id="env-default",
            name="Env-configured (R2_*)",
            kind="r2",
            endpoint=f"https://{account_id}.r2.cloudflarestorage.com",
            bucket=os.getenv("R2_BUCKET") or "yt-agent",
            access_key_id=os.getenv("R2_ACCESS_KEY_ID") or "",
            secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY") or "",
            public_base=(os.getenv("R2_PUBLIC_URL") or "").rstrip("/"),
            region="auto",
            path_style=True,
            is_primary=True,
            enabled=True,
            extras={"account_id": account_id},
        )

    # 3. SFTP only.
    if os.getenv("SFTP_HOST"):
        return ProviderConfig(
            id="env-default",
            name="Env-configured (SFTP_*)",
            kind="hostinger_sftp",
            host=os.getenv("SFTP_HOST") or "",
            port=int(os.getenv("SFTP_PORT") or 22),
            user=os.getenv("SFTP_USER") or "",
            password=os.getenv("SFTP_PASS") or "",
            base_dir=os.getenv("SFTP_BASE_DIR") or "",
            public_base=(os.getenv("PUBLIC_BASE_URL") or "").rstrip("/"),
            is_primary=True,
            enabled=True,
        )

    return None


def _refresh_locked() -> None:
    """MUST be called with _lock held. Re-reads Pocketbase providers
    and updates _primary / _mirror / _all."""
    global _primary, _mirror, _all, _cache_at

    try:
        from backend import db as _db
        if _db.is_configured():
            rows = []
            try:
                # backend.db abstracts Firestore-vs-Pocketbase. After the
                # G2 migration the client supports collection().get_full_list().
                c = _db.client()
                rows = c.collection("storage_providers").get_full_list(
                    query_params={"sort": "-is_primary,name"}
                )
            except AttributeError:
                # Pre-G2 (Firestore Admin SDK shape) — list documents.
                snap = c.collection("storage_providers").stream()
                rows = [{**d.to_dict(), "id": d.id} for d in snap]

            primary: Optional[StorageProvider] = None
            mirror: Optional[StorageProvider] = None
            allp: dict[str, StorageProvider] = {}

            for row in rows:
                if not row.get("enabled", True):
                    continue
                try:
                    cfg = _hydrate_from_pb_row(row)
                    p = _build_provider(cfg)
                    allp[cfg.id] = p
                    if cfg.is_primary:
                        primary = p
                    if cfg.is_mirror:
                        mirror = p
                except Exception as e:
                    log.warning("storage registry: skipping provider %s: %s",
                                row.get("id"), e)

            # If no rows defined OR none flagged primary, fall back to env.
            if primary is None:
                envcfg = _envvar_fallback_config()
                if envcfg is not None:
                    primary = _build_provider(envcfg)
                    allp[envcfg.id] = primary

            _primary, _mirror, _all = primary, mirror, allp
            _cache_at = time.time()
            return
    except Exception as e:
        log.warning("storage registry: Pocketbase read failed (%s); env fallback", e)

    # Pocketbase unreachable or backend.db not configured — env fallback only.
    envcfg = _envvar_fallback_config()
    _primary = _build_provider(envcfg) if envcfg else None
    _mirror = None
    _all = {_primary.id: _primary} if _primary else {}
    _cache_at = time.time()


def _ensure_fresh() -> None:
    with _lock:
        if (time.time() - _cache_at) > _CACHE_TTL:
            _refresh_locked()


def primary() -> Optional[StorageProvider]:
    _ensure_fresh()
    return _primary


def mirror() -> Optional[StorageProvider]:
    _ensure_fresh()
    return _mirror


def all_providers() -> dict[str, StorageProvider]:
    _ensure_fresh()
    return dict(_all)


def reload() -> None:
    """Force-refresh on next access. Used by the /api/storage/providers
    routes after a write so the next render sees the change immediately."""
    global _cache_at
    with _lock:
        _cache_at = 0.0


def get(provider_id: str) -> Optional[StorageProvider]:
    _ensure_fresh()
    return _all.get(provider_id)
