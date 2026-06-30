"""
Public storage API — same shape as the legacy module so callers don't
change.

This module replaces backend.storage.upload_video etc. when the user
opts into the new registry by setting STORAGE_BACKEND=registry.

Differences from _legacy.py:
  - upload_video writes to PRIMARY provider (whatever it is — MinIO,
    R2, AWS S3, SFTP). MIRROR provider (if defined) gets a best-effort
    write too, logged separately.
  - public_video_url still consults runs_index first (so any migrated
    URL is honoured) before falling back to the primary's public URL.
  - usage_summary aggregates across every active provider, not just
    R2 + SFTP.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Optional

from . import registry as _reg
from .providers.base import StorageProvider, UploadResult

log = logging.getLogger(__name__)


VIDEOS_PREFIX = "videos"


# ── Public API ─────────────────────────────────────────────────

def is_configured() -> bool:
    """True iff a primary provider is available."""
    return _reg.primary() is not None


def secondary_is_configured() -> bool:
    """True iff a mirror provider is configured."""
    return _reg.mirror() is not None


def reload_env() -> None:
    """Force the registry to re-fetch from Pocketbase + re-read env on
    next access. Used by /api/storage/providers routes after edits."""
    _reg.reload()


def upload_video(local_path: str, run_id: str) -> str:
    """Upload the rendered mp4 to PRIMARY. Returns the public URL.

    Also writes to MIRROR if one is configured — mirror failures are
    logged but never raise.
    """
    primary = _reg.primary()
    if primary is None:
        raise RuntimeError(
            "storage not configured (no provider defined in Pocketbase "
            "and no env vars matched). Visit /storage in the dashboard."
        )

    local = Path(local_path)
    if not local.exists():
        raise FileNotFoundError(local)

    key = f"{VIDEOS_PREFIX}/{run_id}.mp4"
    t0 = time.time()
    result: UploadResult = primary.put_file(key, str(local), "video/mp4")
    size_mb = local.stat().st_size / (1024 * 1024)
    log.info(
        f"{primary.kind}:{primary.id} uploaded {size_mb:.1f} MB in "
        f"{time.time()-t0:.1f}s → {result.public_url}"
    )

    # Mirror — best effort.
    mirror = _reg.mirror()
    if mirror is not None and mirror.id != primary.id:
        try:
            t1 = time.time()
            mirror.put_file(key, str(local), "video/mp4")
            log.info(
                f"mirror {mirror.kind}:{mirror.id} OK in "
                f"{time.time()-t1:.1f}s"
            )
        except Exception as e:
            log.warning(
                f"mirror {mirror.kind}:{mirror.id} failed (non-fatal): {e}"
            )
            # Surface to /health via the errors collection.
            try:
                from backend import notifier
                notifier.report_error(
                    e,
                    title=f"mirror upload to {mirror.name} failed",
                    extra={"run_id": run_id, "provider": mirror.id},
                    level="warn",
                    fire_discord=False,
                )
            except Exception:
                pass

    return result.public_url


def public_video_url(run_id: str) -> str:
    """Best-effort URL for a run's video. Consults runs_index first
    (honours any migrated URL), then falls back to the primary's
    canonical location."""
    try:
        from backend import runs_db
        for entry in runs_db.list_index(limit=500):
            if entry.get("run_id") == run_id and entry.get("video_url"):
                return entry["video_url"]
    except Exception:
        pass
    primary = _reg.primary()
    if primary is None:
        return ""
    return primary.public_url(f"{VIDEOS_PREFIX}/{run_id}.mp4")


def delete_remote(remote_key: str) -> None:
    """Delete a video file. We delete from EVERY enabled provider —
    cleanup should leave nothing behind even if the file was mirrored."""
    for p in _reg.all_providers().values():
        try:
            p.delete(remote_key)
        except Exception as e:
            log.warning(f"delete {remote_key} on {p.kind}:{p.id}: {e}")


def usage_summary() -> dict:
    """Used by /health and Monitor page."""
    providers = _reg.all_providers()
    primary = _reg.primary()
    mirror = _reg.mirror()

    per_provider = []
    for pid, p in providers.items():
        used = 0
        try:
            used = p.total_bytes(VIDEOS_PREFIX + "/")
        except Exception:
            pass
        per_provider.append({
            "id":          pid,
            "name":        p.name,
            "kind":        p.kind,
            "is_primary":  pid == (primary.id if primary else None),
            "is_mirror":   pid == (mirror.id if mirror else None),
            "video_bytes": used,
            "video_gb":    round(used / (1024 ** 3), 3),
        })

    return {
        "primary_configured":   primary is not None,
        "secondary_configured": mirror is not None,
        "active_kind":          primary.kind if primary else None,
        "primary_id":           primary.id if primary else None,
        "mirror_id":            mirror.id if mirror else None,
        "providers":            per_provider,
    }
