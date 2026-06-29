"""
storage.py — Video file storage facade (R2 primary + Hostinger SFTP archive).

After the Firestore refactor, this module is ONLY responsible for
binary files (videos). All structured data (registry, keys, settings,
runs index) lives in Firestore — see backend/db.py.

  PRIMARY    Cloudflare R2 (HTTPS, S3-compatible)
  SECONDARY  Hostinger SFTP — archival when R2 fills up

R2 is the default. After each video upload, _maybe_migrate() checks
total R2 usage; if it crosses R2_MAX_GB (default 7 GB out of the 10 GB
free tier), the oldest videos are downloaded from R2, uploaded to
Hostinger via SFTP, and the per-run `video_url` is rewritten in
Firestore so the frontend just plays from whichever tier holds the file.

Public interface:
    is_configured()                primary tier ready
    upload_video(path, run_id)     → public URL (R2 or SFTP fallback)
    public_video_url(run_id)       → URL honouring migration
    delete_remote(remote_key)      → delete a file from active tier
    usage_summary()                → R2 byte count + tier flags (Monitor)

Required env vars:
    Primary (R2):
        R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
        R2_BUCKET, R2_PUBLIC_URL
    Secondary (Hostinger SFTP, optional — enables archive migration):
        SFTP_HOST, SFTP_USER, SFTP_PASS, SFTP_PORT, SFTP_BASE_DIR,
        PUBLIC_BASE_URL
        R2_MAX_GB                  (default 7.0)
"""
import os
import json
import time
import socket
import logging
import tempfile
import threading
from pathlib import Path

log = logging.getLogger(__name__)


def _env(name, default=""):
    v = os.getenv(name, default)
    return v if v not in ("", None) else default


# ── Primary (R2) ────────────────────────────────────────────
R2_ACCOUNT_ID         = _env("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID      = _env("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY  = _env("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET             = _env("R2_BUCKET", "yt-agent")
R2_PUBLIC_URL         = _env("R2_PUBLIC_URL", "").rstrip("/")
R2_MAX_GB             = float(_env("R2_MAX_GB", "7") or 7)
R2_ENDPOINT = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com" if R2_ACCOUNT_ID else ""


def reload_env() -> None:
    """Re-read R2_* and SFTP_* env vars into the module globals.

    Why: server.py imports this module BEFORE keys_sync.pull_into_env()
    runs in the startup hook. On workers that get their R2/SFTP creds
    from Firestore (Kaggle especially — Kaggle's secrets-panel UI
    detaches per-version, so storing them in Firestore is the only
    sane path), the module-level constants captured "" at import time.
    Calling this after keys_sync.pull_into_env() refreshes them.

    Idempotent. Safe to call multiple times.
    """
    global R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    global R2_BUCKET, R2_PUBLIC_URL, R2_ENDPOINT
    global SFTP_HOST, SFTP_PORT, SFTP_USER, SFTP_PASS, SFTP_BASE_DIR
    global PUBLIC_BASE_URL
    global _r2
    R2_ACCOUNT_ID         = _env("R2_ACCOUNT_ID", "")
    R2_ACCESS_KEY_ID      = _env("R2_ACCESS_KEY_ID", "")
    R2_SECRET_ACCESS_KEY  = _env("R2_SECRET_ACCESS_KEY", "")
    R2_BUCKET             = _env("R2_BUCKET", "yt-agent")
    R2_PUBLIC_URL         = _env("R2_PUBLIC_URL", "").rstrip("/")
    R2_ENDPOINT = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com" if R2_ACCOUNT_ID else ""
    SFTP_HOST     = _env("SFTP_HOST", _env("FTP_HOST", ""))
    SFTP_PORT     = int(_env("SFTP_PORT", _env("FTP_PORT", "22")) or 22)
    SFTP_USER     = _env("SFTP_USER", _env("FTP_USER", ""))
    SFTP_PASS     = _env("SFTP_PASS", _env("FTP_PASS", ""))
    SFTP_BASE_DIR = _env("SFTP_BASE_DIR", _env("FTP_BASE_DIR", "")).rstrip("/")
    PUBLIC_BASE_URL = _env("PUBLIC_BASE_URL", "").rstrip("/")
    # Invalidate any cached boto3 client so the next call uses the new creds.
    _r2 = None
    log.info(f"storage: env reloaded (r2_configured={r2_configured()}, "
             f"sftp_configured={sftp_configured()})")

# ── Secondary (Hostinger SFTP) ──────────────────────────────
SFTP_HOST             = _env("SFTP_HOST", _env("FTP_HOST", ""))
SFTP_USER             = _env("SFTP_USER", _env("FTP_USER", ""))
SFTP_PASS             = _env("SFTP_PASS", _env("FTP_PASS", ""))
SFTP_PORT             = int(_env("SFTP_PORT", "65002") or 65002)
SFTP_BASE_DIR         = _env("SFTP_BASE_DIR", _env("FTP_BASE_DIR", "")).rstrip("/")
SECONDARY_PUBLIC_URL  = _env("PUBLIC_BASE_URL", "").rstrip("/")

# Back-compat exports.
PUBLIC_BASE_URL = R2_PUBLIC_URL or SECONDARY_PUBLIC_URL
FTP_BASE_DIR    = SFTP_BASE_DIR

VIDEOS_PREFIX = "videos"


def r2_configured() -> bool:
    return bool(R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
                and R2_BUCKET and R2_PUBLIC_URL)


def sftp_configured() -> bool:
    return bool(SFTP_HOST and SFTP_USER and SFTP_PASS and SFTP_BASE_DIR
                and SECONDARY_PUBLIC_URL)


def is_configured() -> bool:
    """Either tier counts — R2 OR SFTP is enough to upload videos."""
    return r2_configured() or sftp_configured()


def secondary_is_configured() -> bool:
    """Both R2 (primary) AND SFTP (archive) — required for migration."""
    return r2_configured() and sftp_configured()


def _public_base() -> str:
    return R2_PUBLIC_URL if r2_configured() else SECONDARY_PUBLIC_URL


# ── R2 client (boto3) ──────────────────────────────────────
_r2 = None


def _r2c():
    global _r2
    if _r2 is None:
        import boto3
        from botocore.config import Config
        _r2 = boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=10,
                read_timeout=60,
            ),
        )
    return _r2


# Single-PUT cutoff. Files at-or-under this size go through put_object
# (no multipart, no chunk-streaming code path) which sidesteps the
# urllib3/truststore/boto3 SSL-handshake recursion that was breaking
# uploads. A 60-sec YouTube Short at 1080p is typically 5-20 MB; even
# upgrading to 1080p60 stays well under 100 MB. Files larger than this
# fall back to upload_file (multipart) — they're rare and we tolerate
# the existing recursion risk for them.
_SINGLE_PUT_MAX_BYTES = 100 * 1024 * 1024

# urllib3 + truststore + boto3 multipart can recurse deeply during SSL
# handshakes. Raise Python's default recursion ceiling so a renegotiation
# storm doesn't manifest as 'maximum recursion depth exceeded'. 5000 is
# safe — the deepest legitimate boto3 stack we've seen is ~600 frames.
try:
    import sys as _sys
    if _sys.getrecursionlimit() < 5000:
        _sys.setrecursionlimit(5000)
except Exception:
    pass


def _r2_put_file(key: str, local_path: str, content_type: str) -> str:
    """Atomic upload: stage to a `.tmp` key, then server-side rename.

    Two upload paths chosen by file size:

      • Files ≤ _SINGLE_PUT_MAX_BYTES (default 100 MB) use put_object
        with the file streamed as Body. NO multipart logic touched —
        this is the path that dodges the boto3/urllib3 SSL recursion
        bug ("maximum recursion depth exceeded" on big chunk uploads).

      • Larger files use upload_file which auto-chunks. Recursion bug
        risk remains there but we accept it — at our scale (~5-20 MB
        Shorts) we never hit this branch in practice.

    Atomicity: both paths upload to a hidden staging key first
    (`{key}.tmp.{pid}.{epoch}`), then server-side copy to the final key,
    then delete staging. Readers of `{key}` see either the complete
    file or no file at all — never a partial.
    """
    import time as _time
    staging = f"{key}.tmp.{os.getpid()}.{int(_time.time())}"
    client = _r2c()
    size = 0
    try:
        size = os.path.getsize(local_path)
    except OSError:
        size = 0
    try:
        if 0 < size <= _SINGLE_PUT_MAX_BYTES:
            # Single PUT — no multipart, no chunked stream, no recursion
            # bug. Body=file-handle lets boto3 stream from disk without
            # loading the whole thing into memory.
            log.info(f"R2 single-PUT {size/1024/1024:.1f} MB -> {staging}")
            with open(local_path, "rb") as f:
                client.put_object(
                    Bucket=R2_BUCKET,
                    Key=staging,
                    Body=f,
                    ContentType=content_type,
                )
        else:
            # Large file (>100 MB) or empty stat — fall back to
            # upload_file which handles multipart. Recursion risk noted.
            log.info(f"R2 multipart upload {size/1024/1024:.1f} MB -> {staging}")
            client.upload_file(
                local_path, R2_BUCKET, staging,
                ExtraArgs={"ContentType": content_type},
            )

        # Server-side copy → final key (atomic; readers see the new object).
        client.copy_object(
            Bucket=R2_BUCKET,
            Key=key,
            CopySource={"Bucket": R2_BUCKET, "Key": staging},
            ContentType=content_type,
            MetadataDirective="REPLACE",
        )
        # Drop the staging key.
        try:
            client.delete_object(Bucket=R2_BUCKET, Key=staging)
        except Exception as _e:
            log.debug(f"r2 staging cleanup non-fatal: {_e}")
        return f"{R2_PUBLIC_URL}/{key}"

    except RecursionError as e:
        # Specific case: the boto3/urllib3 SSL recursion bug. If we hit
        # this on the single-PUT path something's deeply wrong; on the
        # multipart path it's the known bug. Either way, clean up and
        # surface clearly.
        log.error(f"R2 upload hit RecursionError on {key} ({size/1024/1024:.1f} MB) — "
                  f"likely urllib3/truststore SSL handshake recursion")
        _r2_cleanup_staging(client, staging)
        raise RuntimeError(
            f"R2 upload failed for {key}: RecursionError "
            f"(urllib3/SSL recursion). File was {size/1024/1024:.1f} MB."
        ) from e
    except Exception as e:
        _r2_cleanup_staging(client, staging)
        raise RuntimeError(f"R2 upload failed for {key}: {e}") from e


def _r2_cleanup_staging(client, staging: str) -> None:
    """Best-effort: kill the staging object + abort any incomplete
    multipart uploads under it so we don't leave broken bytes."""
    try:
        client.delete_object(Bucket=R2_BUCKET, Key=staging)
    except Exception:
        pass
    try:
        mpu = client.list_multipart_uploads(Bucket=R2_BUCKET, Prefix=staging)
        for u in mpu.get("Uploads", []):
            client.abort_multipart_upload(
                Bucket=R2_BUCKET, Key=u["Key"], UploadId=u["UploadId"],
            )
    except Exception:
        pass


def _r2_delete(key: str) -> bool:
    try:
        _r2c().delete_object(Bucket=R2_BUCKET, Key=key)
        return True
    except Exception as e:
        log.warning(f"r2 delete {key}: {e}")
        return False


def _r2_list(prefix: str = "") -> list[dict]:
    """List objects under prefix. Quiet on failure — callers handle the
    empty-list case gracefully (cached size, migration skipped, etc.).
    Errors here often come from boto3/truststore SSL conflicts that we
    can't fix without deep dependency surgery."""
    out = []
    try:
        paginator = _r2c().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=R2_BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                out.append({
                    "key":           obj["Key"],
                    "size":          obj["Size"],
                    "last_modified": obj["LastModified"].timestamp(),
                })
    except Exception as e:
        # Debug-level — _r2_total_bytes caches the failure and we don't
        # want to spam the logs panel every 2s when /api/stats polls.
        log.debug(f"r2 list {prefix}: {e!r}")
    return out


_r2_size_cache: dict[str, tuple[float, int]] = {}      # prefix → (at_epoch, bytes)
_R2_SIZE_TTL = 60.0   # seconds — /api/stats polls every 2s, no need to re-list R2 that often


def _r2_total_bytes(prefix: str = "") -> int:
    """Return cumulative bytes under `prefix`. Cached for _R2_SIZE_TTL
    seconds because /api/stats polls this every 2 seconds and listing R2
    is both wasteful AND has a known interaction with truststore that
    causes RecursionError in some configurations."""
    now = time.time()
    cached = _r2_size_cache.get(prefix)
    if cached and (now - cached[0]) < _R2_SIZE_TTL:
        return cached[1]
    try:
        total = sum(o["size"] for o in _r2_list(prefix))
        _r2_size_cache[prefix] = (now, total)
        return total
    except Exception as e:
        # Botocore + truststore can raise RecursionError, SSL errors,
        # or transient network blips. Return the last good value if we
        # have one, else 0 — never propagate to the /api/stats handler.
        log.debug(f"_r2_total_bytes({prefix!r}) failed, using last known: {e!r}")
        if cached:
            return cached[1]
        return 0


def _r2_download_to(key: str, local_path: str) -> bool:
    try:
        _r2c().download_file(R2_BUCKET, key, local_path)
        return True
    except Exception as e:
        log.warning(f"r2 download {key}: {e}")
        return False


# ── SFTP (secondary, archive) ──────────────────────────────
_sftp_lock = threading.Lock()
_sftp_t = None
_sftp_s = None


def _resolve_ipv4(host: str, port: int) -> str:
    for af, _, _, _, sa in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        if af == socket.AF_INET:
            return sa[0]
    raise OSError(f"no IPv4 address found for {host!r}")


def _sftp_get():
    global _sftp_t, _sftp_s
    import paramiko
    with _sftp_lock:
        if _sftp_t is not None and _sftp_t.is_active():
            try:
                _sftp_s.stat(".")
                return _sftp_t, _sftp_s
            except Exception:
                log.warning("secondary sftp stale — reconnecting")
        for o in (_sftp_s, _sftp_t):
            try:
                if o: o.close()
            except Exception:
                pass
        _sftp_t = _sftp_s = None
        ip = _resolve_ipv4(SFTP_HOST, SFTP_PORT)
        t = paramiko.Transport((ip, SFTP_PORT))
        t.banner_timeout = 15
        t.connect(username=SFTP_USER, password=SFTP_PASS)
        s = paramiko.SFTPClient.from_transport(t)
        _sftp_t, _sftp_s = t, s
        return t, s


def _sftp_mkdir_p(sftp, path: str):
    parts = [p for p in path.split("/") if p]
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.mkdir(cur)
        except IOError:
            pass


def _sftp_put_file(local_path: str, remote_key: str) -> str:
    """Upload to secondary. Returns the Hostinger public URL."""
    remote_path = f"{SFTP_BASE_DIR}/{remote_key}"
    remote_dir = remote_path.rsplit("/", 1)[0]
    _, sftp = _sftp_get()
    _sftp_mkdir_p(sftp, remote_dir)
    sftp.put(local_path, remote_path)
    return f"{SECONDARY_PUBLIC_URL}/{remote_key}"


def _sftp_delete(remote_key: str) -> bool:
    try:
        _, sftp = _sftp_get()
        try:
            sftp.remove(f"{SFTP_BASE_DIR}/{remote_key}")
            return True
        except IOError:
            return False
    except Exception as e:
        log.warning(f"sftp delete {remote_key}: {e}")
        return False


# ── Public API ─────────────────────────────────────────────
def upload_video(local_path: str, run_id: str) -> str:
    """Upload the rendered mp4. Returns the public URL.

    R2 is the default tier. If only SFTP is configured, falls back to
    that. After a successful R2 upload, triggers a migration check
    (best-effort)."""
    if not is_configured():
        raise RuntimeError("storage not configured (need either R2_* or SFTP_*)")
    local = Path(local_path)
    if not local.exists():
        raise FileNotFoundError(local)
    key = f"{VIDEOS_PREFIX}/{run_id}.mp4"
    t0 = time.time()
    if r2_configured():
        url = _r2_put_file(key, str(local), "video/mp4")
        tier = "R2"
    else:
        url = _sftp_put_file(str(local), key)
        tier = "SFTP"
    size_mb = local.stat().st_size / (1024 * 1024)
    log.info(f"{tier} uploaded {size_mb:.1f} MB in {time.time()-t0:.1f}s → {url}")
    if r2_configured():
        try:
            _maybe_migrate()
        except Exception as e:
            log.warning(f"migration check failed: {e}")
    return url


def public_video_url(run_id: str) -> str:
    """Best-effort URL for a run's video. Honour the per-run video_url
    stored in Firestore runs_index (which may point at Hostinger if the
    video was migrated). Falls back to active tier's canonical location."""
    try:
        from backend import runs_db
        for entry in runs_db.list_index(limit=500):
            if entry.get("run_id") == run_id and entry.get("video_url"):
                return entry["video_url"]
    except Exception:
        pass
    base = _public_base()
    return f"{base}/{VIDEOS_PREFIX}/{run_id}.mp4" if base else ""


def delete_remote(remote_key: str):
    """Delete a video file from the active tier by key relative to bucket/base."""
    if not is_configured():
        return
    if r2_configured():
        _r2_delete(remote_key)
    else:
        _sftp_delete(remote_key)


# ── Migration: R2 → SFTP archive ───────────────────────────
_GB = 1024 ** 3
_migration_lock = threading.Lock()
_last_migration_check = 0.0


def _maybe_migrate():
    """If R2 video bytes > R2_MAX_GB, move oldest videos to Hostinger
    until usage drops to R2_MAX_GB - 1 GB headroom. Patches the
    Firestore runs_index entry so the frontend keeps playing the file."""
    global _last_migration_check
    if not r2_configured() or not sftp_configured():
        return
    now = time.time()
    if now - _last_migration_check < 300:
        return
    _last_migration_check = now

    with _migration_lock:
        used = _r2_total_bytes(VIDEOS_PREFIX + "/")
        limit = int(R2_MAX_GB * _GB)
        if used < limit:
            return

        target_free = limit - int(1.0 * _GB)
        log.warning(
            f"R2 video usage {used/_GB:.2f} GB exceeds {R2_MAX_GB} GB — "
            f"migrating oldest to Hostinger (target: {target_free/_GB:.2f} GB)"
        )

        videos = [o for o in _r2_list(VIDEOS_PREFIX + "/")
                  if o["key"].endswith(".mp4")]
        videos.sort(key=lambda o: o["last_modified"])  # oldest first

        migrated = []
        for v in videos:
            if used <= target_free:
                break
            run_id = Path(v["key"]).stem
            if _migrate_one(v["key"], run_id, v["size"]):
                used -= v["size"]
                migrated.append(run_id)
        log.info(f"migrated {len(migrated)} videos; R2 now {used/_GB:.2f} GB")


def _migrate_one(r2_key: str, run_id: str, size: int) -> bool:
    """Move one video R2 → Hostinger and patch its Firestore index entry."""
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
            tmp = tf.name
        try:
            if not _r2_download_to(r2_key, tmp):
                return False
            new_url = _sftp_put_file(tmp, f"{VIDEOS_PREFIX}/{run_id}.mp4")
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass

        # Patch the Firestore index entry so the frontend plays from
        # the new location.
        try:
            from backend import db
            if db.is_configured():
                c = db.client()
                c.collection("runs_index").document(run_id).set({
                    "video_url":     new_url,
                    "video_storage": "secondary",
                    "updated_at":    db.server_timestamp(),
                }, merge=True)
        except Exception as e:
            log.warning(f"migrate {run_id}: Firestore patch failed: {e}")

        _r2_delete(r2_key)
        log.info(f"migrated {run_id}.mp4 ({size/(1024*1024):.1f} MB) → Hostinger")
        return True
    except Exception as e:
        log.warning(f"migrate {run_id}: {e}")
        return False


# ── Diagnostics ────────────────────────────────────────────
def usage_summary() -> dict:
    """Used by the debug endpoint + Monitor page."""
    out = {
        "primary_configured":   is_configured(),
        "secondary_configured": secondary_is_configured(),
        "r2_configured":        r2_configured(),
        "sftp_configured":      sftp_configured(),
        "active_tier":          "r2" if r2_configured() else ("sftp" if sftp_configured() else None),
        "r2_public_url":        R2_PUBLIC_URL,
        "secondary_public_url": SECONDARY_PUBLIC_URL,
        "public_base":          _public_base(),
        "r2_max_gb":            R2_MAX_GB,
    }
    if r2_configured():
        try:
            used = _r2_total_bytes(VIDEOS_PREFIX + "/")
            out["r2_video_bytes"] = used
            out["r2_video_gb"]    = round(used / _GB, 3)
        except Exception as e:
            out["r2_video_error"] = repr(e)
    return out
