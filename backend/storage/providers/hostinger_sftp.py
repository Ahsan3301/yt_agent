"""Hostinger SFTP provider — Paramiko-based.

Lifted from the legacy storage module. Same connection caching +
IPv4 resolution + stale-connection detection logic, repackaged behind
the StorageProvider interface.

Unlike the S3-like providers, SFTP doesn't have a HEAD-verify primitive.
We instead stat() the remote file after put and compare sizes — same
guarantee, slightly different implementation.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
from typing import Optional

from .base import StorageProvider, UploadResult

log = logging.getLogger(__name__)


def _resolve_ipv4(host: str, port: int) -> str:
    """Force IPv4 — some hostinger PoPs hand out unreachable AAAA records."""
    for af, _, _, _, sa in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        if af == socket.AF_INET:
            return sa[0]
    raise OSError(f"no IPv4 address found for {host!r}")


class HostingerSftpProvider(StorageProvider):
    """SFTP storage. The base_dir on the remote host is the "bucket"."""

    def __init__(self, config):
        super().__init__(config)
        self._lock = threading.Lock()
        self._transport = None
        self._sftp = None

    # ── Connection lifecycle ───────────────────────────────

    def _get(self):
        """Return (transport, sftp). Reconnects if stale."""
        import paramiko
        with self._lock:
            if self._transport is not None and self._transport.is_active():
                try:
                    self._sftp.stat(".")
                    return self._transport, self._sftp
                except Exception:
                    log.warning(f"sftp:{self.id} stale — reconnecting")
            for obj in (self._sftp, self._transport):
                try:
                    if obj:
                        obj.close()
                except Exception:
                    pass
            self._transport = self._sftp = None

            host = self.config.host
            port = self.config.port or 22
            ip = _resolve_ipv4(host, port)
            t = paramiko.Transport((ip, port))
            t.banner_timeout = 15
            t.connect(username=self.config.user, password=self.config.password)
            s = paramiko.SFTPClient.from_transport(t)
            self._transport, self._sftp = t, s
            return t, s

    def _mkdir_p(self, sftp, path: str) -> None:
        parts = [p for p in path.split("/") if p]
        cur = ""
        for p in parts:
            cur += "/" + p
            try:
                sftp.mkdir(cur)
            except IOError:
                pass  # already exists

    # ── Provider operations ────────────────────────────────

    def put_file(self, key: str, local_path: str, content_type: str) -> UploadResult:
        """Upload + stat-verify. Raises on size mismatch (after a retry)."""
        expected_size = 0
        try:
            expected_size = os.path.getsize(local_path)
        except OSError:
            pass

        remote_path = f"{self.config.base_dir.rstrip('/')}/{key}"
        remote_dir = remote_path.rsplit("/", 1)[0]

        last_err: Optional[Exception] = None
        for attempt in range(1, 3 + 1):
            try:
                _, sftp = self._get()
                self._mkdir_p(sftp, remote_dir)
                log.info(
                    f"sftp:{self.id} put {expected_size/1024/1024:.1f} MB -> "
                    f"{remote_path} (try {attempt}/3)"
                )
                sftp.put(local_path, remote_path)

                # Stat-verify.
                if expected_size > 0:
                    try:
                        st = sftp.stat(remote_path)
                        got = int(getattr(st, "st_size", 0) or 0)
                        if got != expected_size:
                            log.warning(
                                f"sftp:{self.id} verify FAILED for {key}: "
                                f"expected {expected_size}, got {got}"
                            )
                            last_err = RuntimeError(
                                f"verify failed: expected {expected_size}, got {got}"
                            )
                            continue
                    except Exception as e:
                        log.warning(f"sftp:{self.id} verify stat failed: {e}")
                        last_err = e
                        continue

                return UploadResult(
                    public_url=self.public_url(key),
                    bytes_written=expected_size,
                    provider_id=self.id,
                    provider_kind=self.kind,
                )
            except Exception as e:
                log.warning(f"sftp:{self.id} put attempt {attempt} failed: {e}")
                last_err = e
                # Reset connection on error.
                with self._lock:
                    for obj in (self._sftp, self._transport):
                        try:
                            if obj:
                                obj.close()
                        except Exception:
                            pass
                    self._transport = self._sftp = None

        raise RuntimeError(
            f"sftp:{self.id} upload failed for {key}: {last_err}"
        ) from last_err

    def delete(self, key: str) -> bool:
        try:
            _, sftp = self._get()
            try:
                sftp.remove(f"{self.config.base_dir.rstrip('/')}/{key}")
                return True
            except IOError:
                return False
        except Exception as e:
            log.warning(f"sftp:{self.id} delete {key}: {e}")
            return False

    def public_url(self, key: str) -> str:
        base = (self.config.public_base or "").rstrip("/")
        return f"{base}/{key}" if base else ""

    def head(self, key: str) -> Optional[int]:
        try:
            _, sftp = self._get()
            st = sftp.stat(f"{self.config.base_dir.rstrip('/')}/{key}")
            return int(getattr(st, "st_size", 0) or 0)
        except Exception:
            return None

    def health_check(self) -> tuple[bool, str]:
        try:
            _, sftp = self._get()
            sftp.stat(self.config.base_dir.rstrip("/") or ".")
            return True, f"connected to {self.config.host}"
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
