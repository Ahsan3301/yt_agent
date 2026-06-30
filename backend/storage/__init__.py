"""
backend.storage — Video file storage facade.

This package is the public face of storage for the rest of the app.
Callers do `from backend import storage` and call `storage.upload_video(...)`,
`storage.public_video_url(...)`, etc. — exactly as before.

Internals — what was a single 600-line file is now split:

  ./_legacy.py             Original R2 + SFTP implementation. Kept for
                           back-compat during the multi-provider migration.
                           Behaviour-preserving: every export below comes
                           from here when no Pocketbase provider is active.

  ./providers/base.py      `StorageProvider` ABC + `S3LikeProvider`
                           that owns the single-PUT-or-multipart, copy-to-
                           final, head-verify, retry logic (extracted from
                           _legacy._r2_put_file but generalised to any
                           S3-compatible endpoint — MinIO, R2, AWS S3,
                           Wasabi, Backblaze B2).

  ./providers/minio.py     Concrete MinIO provider (path-style addressing).
  ./providers/r2.py        Cloudflare R2 (auto region, account-id endpoint).
  ./providers/aws_s3.py    AWS S3 (region-aware endpoints).
  ./providers/wasabi.py    Wasabi (region-aware).
  ./providers/backblaze_b2.py  Backblaze B2 (S3-compatible).
  ./providers/hostinger_sftp.py  Paramiko SFTP — extracted from _legacy.

  ./crypto.py              AES-GCM encryption for provider secrets stored
                           in Pocketbase (uses STORAGE_PROVIDERS_ENC_KEY).

  ./registry.py            Reads storage_providers from Pocketbase, picks
                           the primary (and optional mirror), instantiates
                           the right provider class. Falls back to env-var
                           configuration via _legacy when no providers are
                           defined yet (fresh deploy).

  ./facade.py              upload_video / public_video_url / delete_remote /
                           usage_summary — the public API. Delegates to the
                           registry; falls back to _legacy when the registry
                           is empty AND env vars are still pointing at R2 +
                           SFTP. Both paths coexist during cutover.

Migration sequence is governed by env var `STORAGE_BACKEND`:
  - unset / "legacy"   → use _legacy directly (current behaviour)
  - "registry"         → use the new provider registry; fall back to
                         _legacy.* env vars only when registry is empty
"""
from __future__ import annotations
import os as _os
import logging as _logging

_log = _logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────
# Public API
#
# Every name below is consumed by callers like backend/jobs.py,
# backend/server.py, backend/stats.py. Keep these exports stable.
# ──────────────────────────────────────────────────────────────────
_BACKEND = (_os.getenv("STORAGE_BACKEND") or "legacy").lower().strip()

if _BACKEND == "registry":
    # New path — uses Pocketbase storage_providers + provider classes.
    try:
        from .facade import (
            is_configured,
            secondary_is_configured,
            reload_env,
            upload_video,
            public_video_url,
            delete_remote,
            usage_summary,
        )
        _log.info("backend.storage: using NEW provider registry")
    except Exception as _e:
        # If the registry can't initialise (Pocketbase down on first boot,
        # missing env var, etc.) gracefully degrade to legacy.
        _log.warning(
            "backend.storage: registry init failed (%s); falling back to legacy", _e,
        )
        from ._legacy import (  # type: ignore[assignment]
            is_configured,
            secondary_is_configured,
            reload_env,
            upload_video,
            public_video_url,
            delete_remote,
            usage_summary,
        )
else:
    # Default — legacy R2 + SFTP path. Zero behaviour change for existing
    # deployments that haven't opted into the new abstraction.
    from ._legacy import (
        is_configured,
        secondary_is_configured,
        reload_env,
        upload_video,
        public_video_url,
        delete_remote,
        usage_summary,
    )


__all__ = [
    "is_configured",
    "secondary_is_configured",
    "reload_env",
    "upload_video",
    "public_video_url",
    "delete_remote",
    "usage_summary",
]
