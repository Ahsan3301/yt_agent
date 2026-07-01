"""
side_jobs.py — post-render actions the worker executes on demand.

Two extra job kinds beyond the standard render:
    publish_youtube — upload an existing run's video to a specified
                       youtube_accounts/<id>.
    copy_storage    — copy the video to another storage provider
                       (mirror or move).

Both operate on an EXISTING run — the run_id is passed in the job
payload. We look up the run's summary/video_url, download the video,
then hand off to the appropriate module (uploader.py or storage
providers). This keeps the render path untouched.
"""
from __future__ import annotations
import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def dispatch(job: dict[str, Any]) -> tuple[bool, str]:
    """Return (ok, error_msg). Job's `kind` decides the handler."""
    kind = str(job.get("kind") or "").strip()
    if kind == "publish_youtube":
        return _publish_youtube(job)
    if kind == "copy_storage":
        return _copy_storage(job)
    return False, f"unknown side-job kind: {kind!r}"


def _get_run_video(run_id: str) -> str | None:
    """Return an absolute local path to the video file for run_id.

    Strategy:
      1. If the standard render dir exists locally, use its final_video.mp4.
      2. Otherwise download from the storage-provider public URL for the run.
    """
    local = Path("output/videos") / run_id / "final_video.mp4"
    if local.exists() and local.stat().st_size > 1024:
        return str(local.resolve())

    # Fetch the runs_index / run_summaries row to find the public URL.
    try:
        from backend import db
        if not db.is_configured():
            return None
        c = db.client()
        idx = c.collection("runs_index").document(run_id).get()
        url = ""
        if idx.exists:
            d = idx.to_dict() or {}
            url = str(d.get("video_url") or d.get("public_url") or "")
        if not url:
            # Fall back to summary.
            sm = c.collection("run_summaries").document(run_id).get()
            if sm.exists:
                data = (sm.to_dict() or {}).get("data") or {}
                url = str(data.get("video_url") or data.get("public_url") or "")
        if not url or not url.startswith("http"):
            return None
        # Stream to a temp file.
        import requests
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            for chunk in r.iter_content(chunk_size=1 << 20):
                tmp.write(chunk)
        tmp.close()
        log.info(f"side_jobs: downloaded {run_id} video from {url} → {tmp.name}")
        return tmp.name
    except Exception as e:
        log.warning(f"side_jobs: _get_run_video({run_id}) failed: {e}")
        return None


def _publish_youtube(job: dict[str, Any]) -> tuple[bool, str]:
    run_id = str(job.get("run_id") or "").strip()
    yt_account_id = str(job.get("youtube_account_id") or "").strip()
    if not run_id or not yt_account_id:
        return False, "publish_youtube requires run_id + youtube_account_id"

    video_path = _get_run_video(run_id)
    if not video_path:
        return False, f"could not locate video for run {run_id}"

    # Pull run summary for title/desc/tags fields.
    title = str(job.get("title") or "")
    description = str(job.get("description") or "")
    tags = job.get("tags") or []
    try:
        from backend import db
        if db.is_configured():
            sm = db.client().collection("run_summaries").document(run_id).get()
            if sm.exists:
                data = (sm.to_dict() or {}).get("data") or {}
                title = title or str(data.get("title") or f"Run {run_id}")
                description = description or str(data.get("description") or "")
                if not tags:
                    tags = data.get("tags") or []
    except Exception:
        pass

    # Delegate to uploader.py — it already knows how to handle
    # per-account credentials via youtube_account_id.
    try:
        from modules import uploader
        vid = uploader.upload_video(
            file_path=video_path,
            title=title or f"Run {run_id}",
            description=description or "",
            tags=list(tags) if isinstance(tags, list) else [],
            youtube_account_id=yt_account_id,
        )
    except TypeError:
        # Older uploader signatures — try without youtube_account_id
        # (best effort; user should update uploader for multi-account).
        try:
            from modules import uploader as _u
            vid = _u.upload_video(video_path, title, description, list(tags) if isinstance(tags, list) else [])
        except Exception as e:
            return False, f"uploader.upload_video failed: {e}"
    except Exception as e:
        return False, f"uploader.upload_video failed: {e}"

    if not vid:
        return False, "uploader returned no video id"

    # Write youtube_video_id back to runs_index so the Library card
    # can show a link.
    try:
        from backend import db
        if db.is_configured():
            c = db.client()
            # Update by direct doc first, then by run_id filter as fallback.
            try:
                c.collection("runs_index").document(run_id).update({
                    "youtube_video_id": vid,
                    "youtube_account_id": yt_account_id,
                    "youtube_url": f"https://youtube.com/watch?v={vid}",
                    "published_at": time.time(),
                })
            except Exception:
                # Row may be keyed by hash — find by field.
                for snap in c.collection("runs_index").where("run_id", "==", run_id).stream():
                    snap.reference.update({
                        "youtube_video_id": vid,
                        "youtube_account_id": yt_account_id,
                        "youtube_url": f"https://youtube.com/watch?v={vid}",
                        "published_at": time.time(),
                    })
    except Exception as e:
        log.warning(f"side_jobs: runs_index update failed: {e}")

    return True, f"published as {vid}"


def _copy_storage(job: dict[str, Any]) -> tuple[bool, str]:
    run_id = str(job.get("run_id") or "").strip()
    provider_id = str(job.get("provider_id") or "").strip()
    move = bool(job.get("move") or False)
    if not run_id or not provider_id:
        return False, "copy_storage requires run_id + provider_id"

    video_path = _get_run_video(run_id)
    if not video_path:
        return False, f"could not locate video for run {run_id}"

    try:
        from backend.storage import registry
        provider = registry.load_by_id(provider_id)
        if not provider:
            return False, f"provider {provider_id} not found or disabled"
        remote_key = f"videos/{run_id}.mp4"
        public_url = provider.put_file(video_path, remote_key, content_type="video/mp4")
    except Exception as e:
        return False, f"provider upload failed: {e}"

    # Update runs_index.mirrors so the UI knows which providers have a copy.
    try:
        from backend import db
        if db.is_configured():
            c = db.client()
            def _upd(row_ref, cur: dict):
                mirrors = list(cur.get("mirrors") or [])
                m = {"provider_id": provider_id, "url": public_url, "copied_at": time.time()}
                # Overwrite existing entry for the same provider.
                mirrors = [x for x in mirrors if x.get("provider_id") != provider_id] + [m]
                row_ref.update({"mirrors": mirrors})
            found = False
            try:
                snap = c.collection("runs_index").document(run_id).get()
                if snap.exists:
                    _upd(snap.reference, snap.to_dict() or {})
                    found = True
            except Exception:
                pass
            if not found:
                for snap in c.collection("runs_index").where("run_id", "==", run_id).stream():
                    _upd(snap.reference, snap.to_dict() or {})
    except Exception as e:
        log.warning(f"side_jobs: runs_index mirror update failed: {e}")

    if move:
        # After a successful copy, delete the source from its current
        # primary — best-effort.
        try:
            from backend import storage
            storage.delete_remote(run_id)  # existing helper drops the primary
        except Exception as e:
            log.warning(f"side_jobs: move source-delete failed: {e}")

    return True, f"copied to {public_url}"
