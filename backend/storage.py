"""
storage.py — Push videos + registry to remote storage over FTP/FTPS.

Designed for Hostinger Business (and any FTPS-capable host). Falls back
to plain FTP if FTPS handshake fails. All credentials come from .env:

    FTP_HOST          ftp.yourdomain.com
    FTP_USER          your_user
    FTP_PASS          your_password
    FTP_PORT          21                  (default; 990 for implicit FTPS)
    FTP_USE_TLS       1                   (1 = FTPS, 0 = plain FTP)
    FTP_BASE_DIR      /public_html/yt-agent
    PUBLIC_BASE_URL   https://yourdomain.com/yt-agent

Any *.json or *.mp4 written under FTP_BASE_DIR/videos/ becomes publicly
fetchable at PUBLIC_BASE_URL/videos/<id>.mp4 once Hostinger serves it.
"""
import os
import io
import ssl
import time
import logging
from pathlib import Path
from ftplib import FTP, FTP_TLS, error_perm

log = logging.getLogger(__name__)


def _env(name, default=""):
    v = os.getenv(name, default)
    return v if v not in ("", None) else default


FTP_HOST       = _env("FTP_HOST", "")
FTP_USER       = _env("FTP_USER", "")
FTP_PASS       = _env("FTP_PASS", "")
FTP_PORT       = int(_env("FTP_PORT", "21") or 21)
FTP_USE_TLS    = _env("FTP_USE_TLS", "1") not in ("0", "false", "False", "")
FTP_BASE_DIR   = _env("FTP_BASE_DIR", "/public_html/yt-agent")
PUBLIC_BASE_URL = _env("PUBLIC_BASE_URL", "").rstrip("/")


def is_configured() -> bool:
    return bool(FTP_HOST and FTP_USER and FTP_PASS and PUBLIC_BASE_URL)


# ── Connection ────────────────────────────────────────────────
def _connect():
    """Return a connected, logged-in FTP[S] client."""
    if not is_configured():
        raise RuntimeError("FTP storage is not configured (FTP_HOST/USER/PASS/PUBLIC_BASE_URL missing)")

    if FTP_USE_TLS:
        try:
            ctx = ssl.create_default_context()
            ftp = FTP_TLS(context=ctx)
            ftp.connect(FTP_HOST, FTP_PORT, timeout=30)
            ftp.login(FTP_USER, FTP_PASS)
            ftp.prot_p()      # encrypt data channel too
            return ftp
        except Exception as e:
            log.warning(f"FTPS handshake failed ({e}); falling back to plain FTP")

    ftp = FTP()
    ftp.connect(FTP_HOST, FTP_PORT, timeout=30)
    ftp.login(FTP_USER, FTP_PASS)
    return ftp


def _mkdir_p(ftp, path: str):
    """Create a directory tree (idempotent)."""
    parts = [p for p in path.split("/") if p]
    cur = "/"
    for p in parts:
        cur = (cur.rstrip("/") + "/" + p)
        try:
            ftp.mkd(cur)
        except error_perm as e:
            if "550" in str(e) or "exists" in str(e).lower():
                pass  # directory already exists
            else:
                raise


# ── Public API ────────────────────────────────────────────────
def upload_video(local_path: str, run_id: str) -> str:
    """Upload a video file. Returns the public URL.

    The target path is:  {FTP_BASE_DIR}/videos/{run_id}.mp4
    The public URL is:   {PUBLIC_BASE_URL}/videos/{run_id}.mp4
    """
    if not is_configured():
        raise RuntimeError("FTP storage not configured")

    local = Path(local_path)
    if not local.exists():
        raise FileNotFoundError(local)

    remote_dir = f"{FTP_BASE_DIR.rstrip('/')}/videos"
    remote_name = f"{run_id}.mp4"

    t0 = time.time()
    ftp = _connect()
    try:
        _mkdir_p(ftp, remote_dir)
        ftp.cwd(remote_dir)
        with open(local, "rb") as f:
            ftp.storbinary(f"STOR {remote_name}", f, blocksize=1024 * 64)
    finally:
        try: ftp.quit()
        except Exception: pass

    size_mb = local.stat().st_size / (1024 * 1024)
    public = f"{PUBLIC_BASE_URL}/videos/{remote_name}"
    log.info(f"FTP uploaded {size_mb:.1f} MB in {time.time()-t0:.1f}s → {public}")
    return public


def upload_json(remote_filename: str, payload: dict | list) -> str:
    """Upload a JSON file (registry, etc.). Returns public URL."""
    if not is_configured():
        raise RuntimeError("FTP storage not configured")

    import json as _json
    data = _json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
    buf = io.BytesIO(data)
    remote_dir = FTP_BASE_DIR.rstrip("/")
    target = f"{remote_dir}/{remote_filename}"

    ftp = _connect()
    try:
        _mkdir_p(ftp, remote_dir)
        ftp.cwd(remote_dir)
        ftp.storbinary(f"STOR {remote_filename}", buf, blocksize=1024 * 32)
    finally:
        try: ftp.quit()
        except Exception: pass

    return f"{PUBLIC_BASE_URL}/{remote_filename}"


def delete_remote(remote_filename: str):
    """Delete a file under FTP_BASE_DIR. Silent on missing."""
    if not is_configured():
        return
    ftp = _connect()
    try:
        ftp.cwd(FTP_BASE_DIR.rstrip("/"))
        try:
            ftp.delete(remote_filename)
        except error_perm:
            pass
    finally:
        try: ftp.quit()
        except Exception: pass
