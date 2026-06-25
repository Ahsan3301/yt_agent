"""
storage.py — Hybrid storage facade.

  PRIMARY    Cloudflare R2 (HTTPS, S3-compatible)
  SECONDARY  Hostinger SFTP — archival when R2 fills up

R2 is the primary for everything: registry.json, keys.json, videos, run
summaries. After each video upload, _maybe_migrate() checks total R2
usage; if it crosses R2_MAX_GB (default 7 GB out of the 10 GB free tier),
the oldest videos are downloaded from R2, uploaded to Hostinger via
SFTP, and the per-run `video_url` is rewritten so the frontend just
plays from whichever tier holds the file.

Public interface (unchanged for callers):
    is_configured()               primary must be configured
    upload_video(path, run_id)    → public URL
    upload_json(name, payload)    → public URL  (used by registry heartbeat)
    upload_json_persistent(...)   = upload_json (no SSH session to keep alive)
    upload_run_summary(rid, d)    → public URL | None
    update_runs_index(entry)      → bool
    remove_from_runs_index(rid)   → bool
    list_remote_runs()            → list of index entries
    fetch_remote_run_summary(rid) → dict | None
    public_video_url(rid)         → URL — honours migration
    download_keys() / upload_keys(d)
    delete_remote(name)
    PUBLIC_BASE_URL               R2 public base (for legacy callers)

Required env vars (primary):
    R2_ACCOUNT_ID
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET                 (e.g. "yt-agent")
    R2_PUBLIC_URL             (e.g. "https://pub-xxx.r2.dev")

Optional (secondary — enables archive migration):
    SFTP_HOST / SFTP_USER / SFTP_PASS
    SFTP_PORT       (default 65002 for Hostinger)
    SFTP_BASE_DIR
    PUBLIC_BASE_URL           (Hostinger's public docroot URL)
    R2_MAX_GB                 (default 7.0)
"""
import os
import io
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

# ── Secondary (Hostinger SFTP) ──────────────────────────────
SFTP_HOST             = _env("SFTP_HOST", _env("FTP_HOST", ""))
SFTP_USER             = _env("SFTP_USER", _env("FTP_USER", ""))
SFTP_PASS             = _env("SFTP_PASS", _env("FTP_PASS", ""))
SFTP_PORT             = int(_env("SFTP_PORT", "65002") or 65002)
SFTP_BASE_DIR         = _env("SFTP_BASE_DIR", _env("FTP_BASE_DIR", "")).rstrip("/")
SECONDARY_PUBLIC_URL  = _env("PUBLIC_BASE_URL", "").rstrip("/")

# Back-compat exports for any caller still referencing the old names.
PUBLIC_BASE_URL = R2_PUBLIC_URL or SECONDARY_PUBLIC_URL
FTP_BASE_DIR    = SFTP_BASE_DIR

# Conventional layout inside R2 bucket / SFTP base dir.
VIDEOS_PREFIX        = "videos"
RUNS_REMOTE_DIR      = "runs"
RUNS_INDEX_FILE      = "index.json"
KEYS_REMOTE_KEY      = ".private/keys.json"   # underscore-prefix on R2 doesn't matter; dotted on Hostinger hides it
REGISTRY_FILENAME    = "registry.json"


def is_configured() -> bool:
    """Primary configured? Secondary is optional."""
    return bool(R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
                and R2_BUCKET and R2_PUBLIC_URL)


def secondary_is_configured() -> bool:
    return bool(SFTP_HOST and SFTP_USER and SFTP_PASS and SFTP_BASE_DIR
                and SECONDARY_PUBLIC_URL)


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


def _r2_put_bytes(key: str, data: bytes, content_type: str) -> str:
    _r2c().put_object(Bucket=R2_BUCKET, Key=key, Body=data, ContentType=content_type)
    return f"{R2_PUBLIC_URL}/{key}"


def _r2_put_file(key: str, local_path: str, content_type: str) -> str:
    _r2c().upload_file(local_path, R2_BUCKET, key,
                       ExtraArgs={"ContentType": content_type})
    return f"{R2_PUBLIC_URL}/{key}"


def _r2_get_bytes(key: str) -> bytes | None:
    try:
        r = _r2c().get_object(Bucket=R2_BUCKET, Key=key)
        return r["Body"].read()
    except Exception as e:
        log.debug(f"r2 get {key}: {e}")
        return None


def _r2_delete(key: str) -> bool:
    try:
        _r2c().delete_object(Bucket=R2_BUCKET, Key=key)
        return True
    except Exception as e:
        log.warning(f"r2 delete {key}: {e}")
        return False


def _r2_list(prefix: str = "") -> list[dict]:
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
        log.warning(f"r2 list {prefix}: {e}")
    return out


def _r2_total_bytes(prefix: str = "") -> int:
    return sum(o["size"] for o in _r2_list(prefix))


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


# ── Public API ─────────────────────────────────────────────
def upload_video(local_path: str, run_id: str) -> str:
    """Upload to R2. Returns the public URL. Triggers migration check."""
    if not is_configured():
        raise RuntimeError("R2 storage not configured")
    local = Path(local_path)
    if not local.exists():
        raise FileNotFoundError(local)
    key = f"{VIDEOS_PREFIX}/{run_id}.mp4"
    t0 = time.time()
    url = _r2_put_file(key, str(local), "video/mp4")
    size_mb = local.stat().st_size / (1024 * 1024)
    log.info(f"R2 uploaded {size_mb:.1f} MB in {time.time()-t0:.1f}s → {url}")
    try:
        _maybe_migrate()
    except Exception as e:
        log.warning(f"migration check failed: {e}")
    return url


def upload_json(remote_filename: str, payload) -> str:
    """Used by registry.py heartbeat. Writes to R2."""
    if not is_configured():
        raise RuntimeError("R2 storage not configured")
    data = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
    return _r2_put_bytes(remote_filename, data, "application/json")


# Aliased for back-compat with registry.py's persistent-fast path.
upload_json_persistent = upload_json


def upload_run_summary(run_id: str, summary: dict) -> str | None:
    if not is_configured():
        return None
    data = json.dumps(summary, indent=2, ensure_ascii=False).encode("utf-8")
    try:
        return _r2_put_bytes(f"{RUNS_REMOTE_DIR}/{run_id}.json", data, "application/json")
    except Exception as e:
        log.warning(f"upload_run_summary({run_id}) failed: {e}")
        return None


def _read_runs_index() -> list[dict]:
    raw = _r2_get_bytes(f"{RUNS_REMOTE_DIR}/{RUNS_INDEX_FILE}")
    if not raw:
        return []
    try:
        d = json.loads(raw.decode("utf-8"))
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _write_runs_index(entries: list[dict]) -> bool:
    data = json.dumps(entries, indent=2, ensure_ascii=False).encode("utf-8")
    try:
        _r2_put_bytes(f"{RUNS_REMOTE_DIR}/{RUNS_INDEX_FILE}", data, "application/json")
        return True
    except Exception as e:
        log.warning(f"write_runs_index failed: {e}")
        return False


def update_runs_index(entry: dict, max_keep: int = 200) -> bool:
    if not is_configured():
        return False
    rid = entry.get("run_id")
    if not rid:
        return False
    entries = _read_runs_index()
    entries = [e for e in entries if isinstance(e, dict) and e.get("run_id") != rid]
    entries.insert(0, entry)
    entries = entries[:max_keep]
    return _write_runs_index(entries)


def remove_from_runs_index(run_id: str) -> bool:
    if not is_configured():
        return False
    entries = [e for e in _read_runs_index() if e.get("run_id") != run_id]
    return _write_runs_index(entries)


def list_remote_runs() -> list[dict]:
    return _read_runs_index()


def fetch_remote_run_summary(run_id: str) -> dict | None:
    raw = _r2_get_bytes(f"{RUNS_REMOTE_DIR}/{run_id}.json")
    if not raw:
        return None
    try:
        d = json.loads(raw.decode("utf-8"))
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def public_video_url(run_id: str) -> str:
    """Honour the per-run video_url if known (migrated videos live on
    Hostinger). Fall back to R2's canonical location."""
    for e in _read_runs_index():
        if e.get("run_id") == run_id and e.get("video_url"):
            return e["video_url"]
    return f"{R2_PUBLIC_URL}/{VIDEOS_PREFIX}/{run_id}.mp4"


def delete_remote(remote_filename: str):
    """Delete from R2 by key relative to bucket root."""
    if not is_configured():
        return
    _r2_delete(remote_filename)


# ── Keys ───────────────────────────────────────────────────
def download_keys() -> dict:
    raw = _r2_get_bytes(KEYS_REMOTE_KEY)
    if not raw:
        return {}
    try:
        d = json.loads(raw.decode("utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception as e:
        log.warning(f"download_keys parse failed: {e}")
        return {}


def upload_keys(keys: dict) -> bool:
    if not is_configured():
        raise RuntimeError("R2 storage not configured")
    data = json.dumps(keys, indent=2).encode("utf-8")
    _r2_put_bytes(KEYS_REMOTE_KEY, data, "application/json")
    log.info(f"upload_keys: pushed {len(keys)} key(s) to R2")
    return True


# ── Migration: R2 → SFTP archive ───────────────────────────
_GB = 1024 ** 3
_migration_lock = threading.Lock()
_last_migration_check = 0.0


def _maybe_migrate():
    """If R2 video bytes > R2_MAX_GB, move oldest videos to Hostinger
    until usage drops to R2_MAX_GB - 1 GB headroom. No-op when there's
    no secondary configured."""
    global _last_migration_check
    if not is_configured() or not secondary_is_configured():
        return
    now = time.time()
    # Rate-limit: list_objects costs an R2 op; skip if checked recently.
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
    """Move one video R2 → Hostinger and update its metadata."""
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

        # Patch per-run summary on R2.
        s = fetch_remote_run_summary(run_id) or {}
        s["video_url"]     = new_url
        s["video_storage"] = "secondary"
        upload_run_summary(run_id, s)

        # Patch the index entry.
        entries = _read_runs_index()
        changed = False
        for e in entries:
            if e.get("run_id") == run_id:
                e["video_url"]     = new_url
                e["video_storage"] = "secondary"
                changed = True
        if changed:
            _write_runs_index(entries)

        # Drop from R2 last (so a partial failure can re-migrate later).
        _r2_delete(r2_key)
        log.info(f"migrated {run_id}.mp4 ({size/(1024*1024):.1f} MB) → Hostinger")
        return True
    except Exception as e:
        log.warning(f"migrate {run_id}: {e}")
        return False


# ── Diagnostics ────────────────────────────────────────────
def usage_summary() -> dict:
    """Used by the debug endpoint."""
    out = {
        "primary_configured":   is_configured(),
        "secondary_configured": secondary_is_configured(),
        "r2_public_url":        R2_PUBLIC_URL,
        "secondary_public_url": SECONDARY_PUBLIC_URL,
        "r2_max_gb":            R2_MAX_GB,
    }
    if is_configured():
        try:
            used = _r2_total_bytes(VIDEOS_PREFIX + "/")
            out["r2_video_bytes"] = used
            out["r2_video_gb"]    = round(used / _GB, 3)
        except Exception as e:
            out["r2_video_error"] = repr(e)
    return out
