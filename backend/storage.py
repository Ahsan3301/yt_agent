"""
storage.py — Push videos + registry to Hostinger over SFTP.

Originally used FTPS but HuggingFace Spaces (and similar PaaS containers)
block outbound port 21. Only ports 22/80/443 reach the open internet from
inside the container. SSH/SFTP on port 22 works fine, so does Hostinger's
shared-hosting SSH (high port 65002).

Connects via paramiko. Credentials come from env vars:

    SFTP_HOST       82.180.138.116            (or ftp.yourdomain.com)
    SFTP_USER       u459456047                (main user, NO ".ytagent")
    SFTP_PASS       your_ssh_password
    SFTP_PORT       65002                     (Hostinger's SSH port)
    SFTP_BASE_DIR   /home/u459456047/domains/.../public_html/yt-agent
    PUBLIC_BASE_URL https://yourdomain.com/yt-agent

Anything written under SFTP_BASE_DIR is served by Apache at the matching
URL under PUBLIC_BASE_URL — same files Apache always served, just written
over SFTP instead of FTP.
"""
import os
import io
import time
import socket
import logging
from pathlib import Path

log = logging.getLogger(__name__)


def _env(name, default=""):
    v = os.getenv(name, default)
    return v if v not in ("", None) else default


# SFTP creds (with FTP_* fallback for back-compat with older deployments).
SFTP_HOST       = _env("SFTP_HOST", _env("FTP_HOST", ""))
SFTP_USER       = _env("SFTP_USER", _env("FTP_USER", ""))
SFTP_PASS       = _env("SFTP_PASS", _env("FTP_PASS", ""))
SFTP_PORT       = int(_env("SFTP_PORT", "65002") or 65002)
SFTP_BASE_DIR   = _env("SFTP_BASE_DIR", _env("FTP_BASE_DIR", "")).rstrip("/")
PUBLIC_BASE_URL = _env("PUBLIC_BASE_URL", "").rstrip("/")

# Back-compat name used elsewhere in the codebase + in the debug endpoint.
FTP_BASE_DIR = SFTP_BASE_DIR


def is_configured() -> bool:
    return bool(SFTP_HOST and SFTP_USER and SFTP_PASS and SFTP_BASE_DIR and PUBLIC_BASE_URL)


# ── Connection ──────────────────────────────────────────────
def _resolve_ipv4(host: str, port: int) -> str:
    """Force IPv4 — containers often lack an IPv6 route, and AAAA-first
    DNS responses cause OSError(101, 'Network is unreachable')."""
    for af, _, _, _, sa in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        if af == socket.AF_INET:
            return sa[0]
    raise OSError(f"no IPv4 address found for {host!r}")


def _connect():
    """Return (transport, sftp). Caller must close both."""
    import paramiko
    if not is_configured():
        raise RuntimeError(
            "SFTP storage not configured "
            "(need SFTP_HOST / SFTP_USER / SFTP_PASS / SFTP_BASE_DIR / PUBLIC_BASE_URL)"
        )
    ip = _resolve_ipv4(SFTP_HOST, SFTP_PORT)
    transport = paramiko.Transport((ip, SFTP_PORT))
    transport.banner_timeout = 15
    transport.connect(username=SFTP_USER, password=SFTP_PASS)
    sftp = paramiko.SFTPClient.from_transport(transport)
    return transport, sftp


def _close(transport, sftp):
    try: sftp.close()
    except Exception: pass
    try: transport.close()
    except Exception: pass


# ── Persistent connection (used by the heartbeat loop) ────────
# Opening a fresh SSH connection every 30s triggers Hostinger's anti-abuse
# throttling. Keep one transport + sftp pair alive across heartbeats; only
# reconnect when the existing session breaks.
import threading
_persistent_lock = threading.Lock()
_persistent_transport = None
_persistent_sftp = None


def _get_persistent():
    """Return a (transport, sftp) pair that's reused across calls.

    Lazily opens on first call. Validates with a cheap `stat(".")` so we
    notice a dead session and reconnect, rather than letting upload fail.
    """
    global _persistent_transport, _persistent_sftp
    with _persistent_lock:
        if _persistent_transport is not None and _persistent_transport.is_active():
            try:
                _persistent_sftp.stat(".")
                return _persistent_transport, _persistent_sftp
            except Exception:
                log.warning("persistent sftp went stale — reconnecting")
        # (Re)open.
        try:
            if _persistent_sftp is not None:
                try: _persistent_sftp.close()
                except Exception: pass
            if _persistent_transport is not None:
                try: _persistent_transport.close()
                except Exception: pass
        finally:
            _persistent_transport = None
            _persistent_sftp = None

        t, s = _connect()
        _persistent_transport, _persistent_sftp = t, s
        return t, s


def upload_json_persistent(remote_filename: str, payload) -> str:
    """Like upload_json but reuses one SSH session across calls. Use this
    from the heartbeat loop to avoid SSH rate-limiting."""
    if not is_configured():
        raise RuntimeError("SFTP storage not configured")
    import json as _json
    data = _json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
    remote_path = f"{SFTP_BASE_DIR}/{remote_filename}"

    # Try with the existing session; on any failure, drop it and retry once.
    for attempt in (1, 2):
        try:
            _, sftp = _get_persistent()
            _mkdir_p(sftp, SFTP_BASE_DIR)
            with sftp.open(remote_path, "wb") as f:
                f.write(data)
            return f"{PUBLIC_BASE_URL}/{remote_filename}"
        except Exception as e:
            log.warning(f"upload_json_persistent attempt {attempt} failed: {e}")
            with _persistent_lock:
                global _persistent_transport, _persistent_sftp
                try:
                    if _persistent_sftp: _persistent_sftp.close()
                except Exception: pass
                try:
                    if _persistent_transport: _persistent_transport.close()
                except Exception: pass
                _persistent_transport = None
                _persistent_sftp = None
            if attempt == 2:
                raise


def _mkdir_p(sftp, path: str):
    """Idempotent recursive mkdir."""
    parts = [p for p in path.split("/") if p]
    cur = ""
    for p in parts:
        cur = cur + "/" + p
        try:
            sftp.mkdir(cur)
        except IOError:
            pass  # already exists or no perms — let the actual put() fail meaningfully


# ── Public API (signature-compatible with the old FTP version) ──
def upload_video(local_path: str, run_id: str) -> str:
    """Upload {run_id}.mp4 to <base>/videos/. Returns its public URL."""
    if not is_configured():
        raise RuntimeError("SFTP storage not configured")
    local = Path(local_path)
    if not local.exists():
        raise FileNotFoundError(local)

    remote_dir = f"{SFTP_BASE_DIR}/videos"
    remote_path = f"{remote_dir}/{run_id}.mp4"

    t0 = time.time()
    transport, sftp = _connect()
    try:
        _mkdir_p(sftp, remote_dir)
        sftp.put(str(local), remote_path)
    finally:
        _close(transport, sftp)

    size_mb = local.stat().st_size / (1024 * 1024)
    public = f"{PUBLIC_BASE_URL}/videos/{run_id}.mp4"
    log.info(f"SFTP uploaded {size_mb:.1f} MB in {time.time()-t0:.1f}s → {public}")
    return public


def upload_json(remote_filename: str, payload) -> str:
    """Upload a JSON blob to <base>/<remote_filename>. Returns public URL."""
    if not is_configured():
        raise RuntimeError("SFTP storage not configured")
    import json as _json
    data = _json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
    remote_path = f"{SFTP_BASE_DIR}/{remote_filename}"

    transport, sftp = _connect()
    try:
        _mkdir_p(sftp, SFTP_BASE_DIR)
        with sftp.open(remote_path, "wb") as f:
            f.write(data)
    finally:
        _close(transport, sftp)
    return f"{PUBLIC_BASE_URL}/{remote_filename}"


# ── Central keys store ──────────────────────────────────────
# Hidden under .private/ — Apache hides dotfile directories by default,
# so it's not HTTP-accessible even though it lives under the docroot.
KEYS_REMOTE_DIR  = _env("SFTP_KEYS_DIR",
                        _env("FTP_KEYS_DIR", f"{SFTP_BASE_DIR}/.private"))
KEYS_REMOTE_FILE = _env("SFTP_KEYS_FILE",
                        _env("FTP_KEYS_FILE", "keys.json"))


def download_keys() -> dict:
    """Fetch shared keys.json. Returns {} on any failure (bootstrap state)."""
    import json as _json
    if not is_configured():
        return {}
    try:
        transport, sftp = _connect()
    except Exception as e:
        log.warning(f"download_keys: SFTP connect failed: {e}")
        return {}
    raw = b""
    try:
        try:
            with sftp.open(f"{KEYS_REMOTE_DIR}/{KEYS_REMOTE_FILE}", "rb") as f:
                raw = f.read()
        except IOError:
            return {}  # file missing — first-run bootstrap
    finally:
        _close(transport, sftp)
    if not raw:
        return {}
    try:
        data = _json.loads(raw.decode("utf-8"))
        if isinstance(data, dict):
            return data
    except Exception as e:
        log.warning(f"download_keys: parse failed: {e}")
    return {}


def upload_keys(keys: dict) -> bool:
    """Write the keys dict to the shared store."""
    import json as _json
    if not is_configured():
        raise RuntimeError("SFTP storage not configured")
    data = _json.dumps(keys, indent=2).encode("utf-8")
    transport, sftp = _connect()
    try:
        _mkdir_p(sftp, KEYS_REMOTE_DIR)
        with sftp.open(f"{KEYS_REMOTE_DIR}/{KEYS_REMOTE_FILE}", "wb") as f:
            f.write(data)
    finally:
        _close(transport, sftp)
    log.info(f"upload_keys: pushed {len(keys)} key(s) to {KEYS_REMOTE_DIR}/{KEYS_REMOTE_FILE}")
    return True


def delete_remote(remote_filename: str):
    """Delete a file under SFTP_BASE_DIR. Silent on missing."""
    if not is_configured():
        return
    transport, sftp = _connect()
    try:
        try:
            sftp.remove(f"{SFTP_BASE_DIR}/{remote_filename}")
        except IOError:
            pass
    finally:
        _close(transport, sftp)


# ── Run history persistence ────────────────────────────────
# Run summaries are mirrored to Hostinger so the History page survives
# backend restarts (HF Space containers wipe /tmp + output/ on restart).
#
#   <base>/runs/<run_id>.json   — full per-run summary
#   <base>/runs/index.json      — list of {run_id, finished_at, ok, ...}
#
# Reads go over plain HTTPS (faster, no SFTP round-trip needed).

RUNS_REMOTE_DIR = "runs"
RUNS_INDEX_FILE = "index.json"


def upload_run_summary(run_id: str, summary: dict) -> str | None:
    """Push a run's summary JSON to Hostinger. Returns the public URL of
    the summary file (mostly informational). Best-effort; returns None
    on failure rather than raising — the local copy is still the source
    of truth for the rest of the pipeline."""
    if not is_configured():
        return None
    import json as _json
    data = _json.dumps(summary, indent=2, ensure_ascii=False).encode("utf-8")
    remote_dir = f"{SFTP_BASE_DIR}/{RUNS_REMOTE_DIR}"
    remote_path = f"{remote_dir}/{run_id}.json"
    try:
        _, sftp = _get_persistent()
        _mkdir_p(sftp, remote_dir)
        with sftp.open(remote_path, "wb") as f:
            f.write(data)
        return f"{PUBLIC_BASE_URL}/{RUNS_REMOTE_DIR}/{run_id}.json"
    except Exception as e:
        log.warning(f"upload_run_summary({run_id}) failed: {e}")
        return None


def _read_runs_index_remote() -> list[dict]:
    """Fetch the runs index via HTTPS (no SFTP). Returns [] on any error."""
    import requests as _req
    if not PUBLIC_BASE_URL:
        return []
    url = f"{PUBLIC_BASE_URL}/{RUNS_REMOTE_DIR}/{RUNS_INDEX_FILE}"
    try:
        r = _req.get(url, timeout=10, headers={"Cache-Control": "no-cache"})
        if r.status_code != 200:
            return []
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        log.debug(f"runs index read miss: {e}")
        return []


def update_runs_index(entry: dict, max_keep: int = 200) -> bool:
    """Read remote index, upsert this entry (by run_id), trim to
    `max_keep`, write back. Best-effort — concurrent writes from
    multiple backends are rare; last-write-wins is acceptable here."""
    if not is_configured():
        return False
    import json as _json
    rid = entry.get("run_id")
    if not rid:
        return False
    entries = _read_runs_index_remote()
    # Drop old copy, prepend new.
    entries = [e for e in entries if isinstance(e, dict) and e.get("run_id") != rid]
    entries.insert(0, entry)
    entries = entries[:max_keep]

    data = _json.dumps(entries, indent=2, ensure_ascii=False).encode("utf-8")
    remote_dir = f"{SFTP_BASE_DIR}/{RUNS_REMOTE_DIR}"
    remote_path = f"{remote_dir}/{RUNS_INDEX_FILE}"
    try:
        _, sftp = _get_persistent()
        _mkdir_p(sftp, remote_dir)
        with sftp.open(remote_path, "wb") as f:
            f.write(data)
        return True
    except Exception as e:
        log.warning(f"update_runs_index failed: {e}")
        return False


def list_remote_runs() -> list[dict]:
    """Public helper for the API layer. Returns the remote runs index
    (HTTPS GET, no SFTP needed)."""
    return _read_runs_index_remote()


def remove_from_runs_index(run_id: str) -> bool:
    """Drop one run from the remote index and write it back."""
    if not is_configured():
        return False
    import json as _json
    entries = [e for e in _read_runs_index_remote()
               if isinstance(e, dict) and e.get("run_id") != run_id]
    data = _json.dumps(entries, indent=2, ensure_ascii=False).encode("utf-8")
    remote_dir = f"{SFTP_BASE_DIR}/{RUNS_REMOTE_DIR}"
    remote_path = f"{remote_dir}/{RUNS_INDEX_FILE}"
    try:
        _, sftp = _get_persistent()
        _mkdir_p(sftp, remote_dir)
        with sftp.open(remote_path, "wb") as f:
            f.write(data)
        return True
    except Exception as e:
        log.warning(f"remove_from_runs_index({run_id}) failed: {e}")
        return False


def fetch_remote_run_summary(run_id: str) -> dict | None:
    """Fetch a single run's full summary from Hostinger via HTTPS."""
    import requests as _req
    if not PUBLIC_BASE_URL:
        return None
    url = f"{PUBLIC_BASE_URL}/{RUNS_REMOTE_DIR}/{run_id}.json"
    try:
        r = _req.get(url, timeout=10, headers={"Cache-Control": "no-cache"})
        if r.status_code != 200:
            return None
        d = r.json()
        return d if isinstance(d, dict) else None
    except Exception as e:
        log.debug(f"remote run summary miss for {run_id}: {e}")
        return None


def public_video_url(run_id: str) -> str:
    """Canonical Hostinger URL for a run's video — used when the local
    copy is gone after a container restart."""
    return f"{PUBLIC_BASE_URL}/videos/{run_id}.mp4"
