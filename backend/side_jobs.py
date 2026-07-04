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

    # Fetch the runs_index / run_summaries row to find the public URL,
    # then fall back to a URL derived from S3_PUBLIC_BASE for
    # storage-only orphans (video landed in MinIO but the DB write
    # failed). Any of the three sources is enough.
    url = ""
    try:
        from backend import db
        if db.is_configured():
            c = db.client()
            idx = c.collection("runs_index").document(run_id).get()
            if idx.exists:
                d = idx.to_dict() or {}
                url = str(d.get("video_url") or d.get("public_url") or "")
            if not url:
                sm = c.collection("run_summaries").document(run_id).get()
                if sm.exists:
                    data = (sm.to_dict() or {}).get("data") or {}
                    url = str(data.get("video_url") or data.get("public_url") or "")
    except Exception as e:
        log.warning(f"side_jobs: PB lookup for {run_id} failed: {e}; will try storage fallback")
    # Storage-only fallback — build the public URL from env. Matches the
    # convention the frontend's storage-list.ts + the worker's uploader
    # both use: {S3_PUBLIC_BASE}/videos/<run_id>.mp4.
    if not url:
        pub_base = (os.getenv("S3_PUBLIC_BASE") or "").rstrip("/")
        if not pub_base:
            # Derive from PUBLIC_BASE_URL + bucket for MinIO on Coolify.
            pb = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")
            bucket = os.getenv("S3_BUCKET") or "yt-agent-videos"
            if pb:
                host = pb if pb.startswith("http") else f"https://{pb}"
                pub_base = f"{host}/{bucket}"
        if pub_base:
            candidate = f"{pub_base}/videos/{run_id}.mp4"
            log.info(f"side_jobs: no PB row for {run_id}; trying storage URL {candidate}")
            url = candidate
    if not url or not url.startswith("http"):
        log.warning(f"side_jobs: cannot locate video for {run_id} (no PB row + no S3_PUBLIC_BASE)")
        return None
    try:
        # Stream to a temp file with retries — MinIO/Traefik can hiccup
        # on cold start and a bare requests.get can bail on any RST. A
        # 3-attempt loop with exponential backoff turns most flakes into
        # invisible retries; only a genuinely dead URL gives up.
        import requests, random as _random
        tmp_name = None
        last_err = None
        for attempt in range(3):
            try:
                tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
                bytes_written = 0
                # (connect, read) — read timeout raised so a slow MinIO
                # doesn't kill a legit long download.
                with requests.get(url, stream=True, timeout=(10, 120)) as r:
                    r.raise_for_status()
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        if not chunk:
                            continue
                        tmp.write(chunk)
                        bytes_written += len(chunk)
                tmp.close()
                if bytes_written < 4096:
                    # Truncated / empty — treat as failure so we retry.
                    try: os.unlink(tmp.name)
                    except Exception: pass
                    raise RuntimeError(f"download produced only {bytes_written} bytes")
                tmp_name = tmp.name
                log.info(
                    f"side_jobs: downloaded {run_id} video from {url} → "
                    f"{tmp_name} ({bytes_written // 1024} KB, attempt {attempt+1})"
                )
                break
            except Exception as e:
                last_err = e
                try: tmp.close()
                except Exception: pass
                try: os.unlink(tmp.name)
                except Exception: pass
                if attempt < 2:
                    wait = (2 ** attempt) + _random.uniform(0, 1)
                    log.warning(
                        f"side_jobs: download attempt {attempt+1}/3 failed "
                        f"({type(e).__name__}: {e}); retrying in {wait:.1f}s"
                    )
                    time.sleep(wait)
        if tmp_name is None:
            log.warning(f"side_jobs: _get_run_video({run_id}) failed after 3 attempts: {last_err}")
            return None
        return tmp_name
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
            c = db.client()
            # Read title/desc/tags from run_summaries.data first (script
            # writer stores under youtube_title/description/tags), then
            # fall back to runs_index for storage-only orphans that
            # never had a summary row. Bug that used to bite here: the
            # worker was reading data.get("title") but the scriptwriter
            # writes youtube_title — so every publish got 'Run <id>'
            # as its title regardless of what the SEO step produced.
            sm = c.collection("run_summaries").document(run_id).get()
            if sm.exists:
                data = (sm.to_dict() or {}).get("data") or {}
                title = title or str(
                    data.get("youtube_title") or data.get("title") or ""
                )
                description = description or str(data.get("description") or "")
                if not tags:
                    tags = data.get("tags") or []
            # Runs_index fallback — set by earlier scriptwriter runs
            # that landed the SEO fields directly on the index doc.
            if not (title and description and tags):
                idx = c.collection("runs_index").document(run_id).get()
                if idx.exists:
                    d = idx.to_dict() or {}
                    title = title or str(d.get("title") or d.get("youtube_title") or "")
                    description = description or str(d.get("description") or "")
                    if not tags:
                        tags = d.get("tags") or []
            # Absolute final fallback so we never publish an empty title.
            if not title:
                title = f"Run {run_id}"
    except Exception:
        pass

    # uploader.upload_video(video_path, script_data, channel_type,
    # youtube_account_id). script_data is a dict with youtube_title /
    # description / tags — we build it from the summary + optional
    # per-job overrides passed in the job payload.
    channel = ""
    try:
        from backend import db
        if db.is_configured():
            idx = db.client().collection("runs_index").document(run_id).get()
            if idx.exists:
                channel = str((idx.to_dict() or {}).get("channel") or "")
    except Exception:
        pass
    script_data = {
        "youtube_title": title or f"Run {run_id}",
        "description":   description or "",
        "tags":          list(tags) if isinstance(tags, list) else [],
    }
    try:
        from modules import uploader
        vid = uploader.upload_video(
            video_path=video_path,
            script_data=script_data,
            channel_type=channel or "horror",
            youtube_account_id=yt_account_id,
        )
    except Exception as e:
        return False, f"uploader.upload_video failed: {e}"

    if not vid:
        return False, "uploader returned no video id"

    # Write youtube_video_id back to runs_index so the Library card
    # can show the YouTube link + preview.
    #
    # Three-way fallback:
    #   1. update by direct doc id
    #   2. update by run_id field query (worker-written rows use a hash)
    #   3. CREATE a new row (storage_only orphans have no row at all)
    #      — without this, publishing a MinIO-only video succeeded on
    #      YouTube but produced no link in the dashboard because the
    #      row it tried to update didn't exist. Now we upsert it.
    pub_url = f"https://youtube.com/watch?v={vid}"
    row_touched = False
    try:
        from backend import db
        if db.is_configured():
            c = db.client()
            payload = {
                "youtube_video_id":   vid,
                "youtube_account_id": yt_account_id,
                "youtube_url":        pub_url,
                "published_at":       time.time(),
            }
            # 1) direct doc id
            try:
                c.collection("runs_index").document(run_id).update(payload)
                row_touched = True
            except Exception:
                pass
            # 2) query by run_id field
            if not row_touched:
                try:
                    for snap in c.collection("runs_index").where("run_id", "==", run_id).stream():
                        snap.reference.update(payload)
                        row_touched = True
                except Exception:
                    pass
            # 3) upsert — no row anywhere, this is a storage_only orphan.
            #    Create a minimal row so the Library card renders the
            #    YouTube link + video_url preview.
            if not row_touched:
                pub_base = (os.getenv("S3_PUBLIC_BASE") or "").rstrip("/")
                video_url = f"{pub_base}/videos/{run_id}.mp4" if pub_base else ""
                try:
                    c.collection("runs_index").document(run_id).set({
                        "run_id":             run_id,
                        "channel":            channel or "",
                        "video_url":          video_url,
                        "public_url":         video_url,
                        "video_storage":      "primary",
                        "finished_at":        time.time(),
                        "status":             "complete",
                        **payload,
                    })
                    row_touched = True
                    log.info(f"side_jobs: created runs_index row for storage-orphan {run_id} + youtube link")
                except Exception as e:
                    log.warning(f"side_jobs: runs_index upsert for {run_id} failed: {e}")
    except Exception as e:
        log.warning(f"side_jobs: runs_index publish-writeback failed: {e}")

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
        provider = registry.get(provider_id)
        if not provider:
            return False, f"provider {provider_id} not found or disabled"
        remote_key = f"videos/{run_id}.mp4"
        # put_file signature is (key, local_path, content_type) — the
        # KEY is where the bytes go on the provider, the LOCAL_PATH is
        # what to upload FROM.
        upload_result = provider.put_file(remote_key, video_path, "video/mp4")
        # base.UploadResult has .public_url; fall back to provider.public_url_for
        # UploadResult exposes .public_url as an attribute (str);
        # provider.public_url(key) is the fallback getter.
        public_url = getattr(upload_result, "public_url", None) or provider.public_url(remote_key)
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
