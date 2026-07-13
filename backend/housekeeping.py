"""
backend.housekeeping — post-render disk cleanup.

Called at the tail of a pipeline run (from backend.jobs and the Oracle
side-worker's entrypoint) to:

  1. Ensure the final_video.mp4 is mirrored to R2 (idempotent — skipped
     if it's already there or the caller already uploaded).
  2. Delete the entire local `output/videos/<run_id>/` folder so
     SDXL frames, TTS wavs, per-shot mp4s, subtitles, and the final
     mp4 don't accumulate on the tenant-shared Oracle VPS.

Only fires on a successful *published* run (dry_run=False, video went
to YouTube). On failures + dry-runs we leave the folder alone so the
operator can inspect / retry.

Callable from ANY worker: works when the run originated on Kaggle,
Colab, or the Oracle CPU-only fallback path.
"""
from __future__ import annotations
import os
import shutil
import logging
from pathlib import Path

log = logging.getLogger(__name__)


def _mirror_to_r2_if_needed(local_path: str, run_id: str, current_public_url: str) -> str:
    """Upload final_video.mp4 to R2 unless we already have a public URL
    that looks like the storage provider's (in which case another
    caller already did it — no point re-uploading a ~50 MB file)."""
    if not local_path or not os.path.exists(local_path):
        return current_public_url or ""
    # If the current URL is already a plausible R2/MinIO/S3 URL, skip.
    if current_public_url and any(
        marker in current_public_url
        for marker in (".r2.cloudflarestorage.com", ".r2.dev",
                       "/api/runs/",  # this is the LOCAL-serve fallback — we DO want to re-upload
                       ".s3.", "minio.", "backblazeb2.com", "wasabisys.com")
    ) and "/api/runs/" not in current_public_url:
        return current_public_url

    try:
        from backend import storage
        if not storage.is_configured():
            return current_public_url or ""
        public = storage.upload_video(local_path, run_id)
        if public:
            log.info(f"housekeeping: mirrored final_video.mp4 for run={run_id} → {public}")
            return public
    except Exception as e:
        log.warning(f"housekeeping: R2 mirror failed for run={run_id}: {e}")
    return current_public_url or ""


def finalize_run(
    work_dir: str,
    run_id: str,
    *,
    published: bool,
    dry_run: bool = False,
    local_video_path: str = "",
    current_public_url: str = "",
) -> dict:
    """Post-publish disk hygiene.

    Parameters:
      work_dir:            output/videos/<run_id> — the folder to nuke
      run_id:              for the R2 key + logging
      published:           was there a successful YouTube upload?
      dry_run:             was this a --dry-run pipeline?
      local_video_path:    absolute path to final_video.mp4 (used for
                           the R2 mirror)
      current_public_url:  what the caller already set as public_url —
                           if already an R2 URL, we skip re-upload

    Returns:
      { "public_url": str, "freed_mb": float, "cleaned": bool, "skipped_reason": str? }
    """
    result = {"public_url": current_public_url or "", "freed_mb": 0.0, "cleaned": False}

    # Guard rails — dry-run always preserved so the operator can inspect
    # the intermediate SDXL frames / TTS audio / storyboard. work_dir
    # missing is a no-op.
    if dry_run:
        result["skipped_reason"] = "dry_run"
        return result
    if not work_dir or not os.path.isdir(work_dir):
        result["skipped_reason"] = f"work_dir missing: {work_dir!r}"
        return result

    # 1) Mirror the final video to R2 FIRST (BEFORE the `published`
    #    guard) so nuking the local folder doesn't orphan the artefact.
    #    Idempotent — skips when the URL is already an object-store
    #    URL. Uses the passed local_video_path (canonical) with a
    #    fallback lookup inside work_dir.
    #
    #    2026-07-13: previously this ran AFTER `if not published:
    #    return`. That meant any successful render whose YouTube
    #    publish failed (no youtube_account_id, YT quota, auth flap,
    #    etc.) leaked its ~1.2 GB work_dir forever. Confirmed live:
    #    Oracle side-worker container had 31 GB of leaked runs from
    #    24 non-published successful renders. Fix is to mirror to R2
    #    first, then decide cleanup based on "is the artifact safe
    #    somewhere durable" — not on "did YT publish succeed".
    lp = local_video_path
    if not lp or not os.path.exists(lp):
        candidate = os.path.join(work_dir, "final_video.mp4")
        if os.path.exists(candidate):
            lp = candidate
    result["public_url"] = _mirror_to_r2_if_needed(lp, run_id, current_public_url)
    has_durable = bool(result["public_url"]) and "/api/runs/" not in result["public_url"]

    # 2) Cleanup decision. Priority order:
    #    a) Published to YouTube  → cleanup (durable URL guaranteed via mirror).
    #    b) Not published + durable R2 URL → cleanup. The video is safe
    #       on object storage; a later YT publish retry can pull it from
    #       R2 without needing the local work_dir.
    #    c) Not published + no durable URL → keep (avoid losing the
    #       artefact entirely).
    if not published and not has_durable:
        result["skipped_reason"] = "not published + no durable URL — keeping local copy"
        log.warning(
            f"housekeeping: keeping {work_dir} — no YouTube publish AND "
            f"no R2 URL (current={result['public_url']!r})"
        )
        return result
    if not has_durable:
        # Published but URL is the local /api/runs/ fallback (R2 down).
        result["skipped_reason"] = "no durable public URL — keeping local copy"
        log.warning(
            f"housekeeping: keeping {work_dir} because no R2 URL "
            f"(current={result['public_url']!r})"
        )
        return result

    # 2) Snapshot size so we can log freed bytes, then rmtree the whole
    #    work_dir. run_summary.json is small (~2 KB) but also goes —
    #    the summary is separately persisted in PB run_summaries by the
    #    caller BEFORE this point, so nothing is lost.
    freed = 0
    try:
        for root, _dirs, files in os.walk(work_dir):
            for f in files:
                try:
                    freed += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    result["freed_mb"] = round(freed / (1024 * 1024), 1)

    try:
        shutil.rmtree(work_dir, ignore_errors=True)
        # Verify it actually went — rmtree with ignore_errors can be
        # silent on partial failure.
        if os.path.isdir(work_dir):
            log.warning(f"housekeeping: rmtree({work_dir}) left the dir behind — partial cleanup")
        else:
            result["cleaned"] = True
            log.info(
                f"housekeeping: cleaned {work_dir} (~{result['freed_mb']} MB freed) "
                f"for run={run_id} — video preserved at {result['public_url']}"
            )
    except Exception as e:
        log.warning(f"housekeeping: rmtree({work_dir}) failed: {e}")

    return result


def force_cleanup(work_dir: str, *, reason: str = "cancelled") -> dict:
    """Unconditionally rmtree the work_dir. No R2 mirror, no guards.

    Used on cancelled / failed / crashed runs where the video is
    worthless and we just want the disk back. The disk-safety guards
    in finalize_run() explicitly refuse to delete on !published, so
    those runs used to leak forever — this is the escape hatch.
    """
    out = {"cleaned": False, "freed_mb": 0.0, "reason": reason}
    if not work_dir or not os.path.isdir(work_dir):
        out["skipped_reason"] = f"work_dir missing: {work_dir!r}"
        return out
    # Guard rail: refuse to nuke anything that isn't clearly a
    # per-run directory under output/videos/<non-empty run_id>. If the
    # caller passed "output/videos" or "output/videos/" (empty run_id
    # after a pre-start crash), rmtree would take out every run.
    abspath = os.path.abspath(work_dir)
    parent = os.path.basename(os.path.normpath(abspath))
    if not parent or parent in ("videos", "output", ".", "/"):
        out["skipped_reason"] = f"refusing to force-clean suspicious path: {abspath}"
        log.error(out["skipped_reason"])
        return out
    freed = 0
    try:
        for root, _dirs, files in os.walk(work_dir):
            for f in files:
                try: freed += os.path.getsize(os.path.join(root, f))
                except OSError: pass
    except OSError:
        pass
    out["freed_mb"] = round(freed / (1024 * 1024), 1)
    try:
        shutil.rmtree(work_dir, ignore_errors=True)
        if not os.path.isdir(work_dir):
            out["cleaned"] = True
            log.info(f"housekeeping: force-cleaned {work_dir} (~{out['freed_mb']} MB freed) — {reason}")
        else:
            log.warning(f"housekeeping: force rmtree({work_dir}) left the dir behind")
    except Exception as e:
        log.warning(f"housekeeping: force rmtree({work_dir}) failed: {e}")
    return out
