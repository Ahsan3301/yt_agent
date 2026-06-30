"""
S3LikeProvider — shared boto3 implementation for every S3-compatible
target (MinIO, Cloudflare R2, AWS S3, Wasabi, Backblaze B2).

This is the hardened upload path lifted out of the legacy R2 code:
  - Single-PUT for ≤100 MB (sidesteps the urllib3/truststore/boto3
    SSL recursion bug that bit us on multipart uploads).
  - Multipart for larger files.
  - Stage to a `.tmp` key → server-side copy to final → head_object
    verifies the byte count → delete staging. Atomic from readers'
    POV; corruption-resistant.
  - Up to 3 attempts with exponential backoff on mismatch / network
    blip / SSL recursion.

Concrete subclasses (minio.py, r2.py, aws_s3.py, ...) only override
the endpoint URL + region + path-style settings.
"""
from __future__ import annotations

import logging
import os
import sys
import time
from typing import Optional

from .base import StorageProvider, UploadResult

log = logging.getLogger(__name__)


# Single-PUT cutoff. Files at-or-under this size go through put_object
# with the file streamed as Body — NO multipart code path, NO chunk-
# streaming. This is the path that dodges the boto3/urllib3 SSL-handshake
# recursion bug ("maximum recursion depth exceeded") on big uploads.
#
# A 60-sec YouTube Short at 1080p is typically 5-20 MB; even upgrading
# to 1080p60 stays well under 100 MB. Files larger than this fall back
# to upload_file (multipart) — they're rare and we tolerate the existing
# recursion risk for them.
_SINGLE_PUT_MAX_BYTES = 100 * 1024 * 1024

# urllib3 + truststore + boto3 multipart can recurse deeply during SSL
# handshakes. Raise Python's default recursion ceiling so a renegotiation
# storm doesn't manifest as 'maximum recursion depth exceeded'. 5000 is
# safe — the deepest legitimate boto3 stack we've seen is ~600 frames.
try:
    if sys.getrecursionlimit() < 5000:
        sys.setrecursionlimit(5000)
except Exception:
    pass


class S3LikeProvider(StorageProvider):
    """Base for every S3-compatible provider. Subclasses customise the
    boto3 client args (endpoint, region, path-style) via class-level
    overrides; the upload + verify + retry plumbing is shared."""

    # Subclasses override these.
    DEFAULT_REGION: str = "auto"
    SIGNATURE_VERSION: str = "s3v4"

    def __init__(self, config):
        super().__init__(config)
        self._client = None

    # ── Boto3 client lifecycle ─────────────────────────────

    def _resolve_endpoint(self) -> str:
        """Subclass hook. Default: use config.endpoint as-is. R2 overrides
        to construct from R2_ACCOUNT_ID; AWS S3 overrides to region-derive."""
        return self.config.endpoint

    def _resolve_region(self) -> str:
        return self.config.region or self.DEFAULT_REGION

    def _path_style(self) -> bool:
        return bool(self.config.path_style)

    def client(self):
        """Lazy boto3 client. Reuses connections per provider instance."""
        if self._client is None:
            import boto3
            from botocore.config import Config

            endpoint = self._resolve_endpoint()
            if not endpoint:
                raise RuntimeError(
                    f"{self.kind} provider {self.id}: endpoint not configured"
                )
            cfg = Config(
                signature_version=self.SIGNATURE_VERSION,
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=10,
                read_timeout=60,
                # Path-style addressing (`endpoint/bucket/key`) is mandatory
                # for MinIO with no DNS-style virtual host setup, optional
                # but safe for everything else.
                s3={"addressing_style": "path" if self._path_style() else "virtual"},
            )
            self._client = boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=self.config.access_key_id,
                aws_secret_access_key=self.config.secret_access_key,
                region_name=self._resolve_region(),
                config=cfg,
            )
        return self._client

    # ── Upload (single-PUT or multipart) + verify + retry ──

    def put_file(self, key: str, local_path: str, content_type: str,
                 *, attempts: int = 3) -> UploadResult:
        """Atomic + VERIFIED upload — see module docstring."""
        expected_size = 0
        try:
            expected_size = os.path.getsize(local_path)
        except OSError:
            pass

        last_err: Optional[Exception] = None
        bucket = self.config.bucket

        for attempt in range(1, attempts + 1):
            staging = f"{key}.tmp.{os.getpid()}.{int(time.time())}.{attempt}"
            client = self.client()
            try:
                if 0 < expected_size <= _SINGLE_PUT_MAX_BYTES:
                    log.info(
                        f"{self.kind}:{self.id} single-PUT "
                        f"{expected_size/1024/1024:.1f} MB -> {staging} "
                        f"(try {attempt}/{attempts})"
                    )
                    with open(local_path, "rb") as f:
                        client.put_object(
                            Bucket=bucket,
                            Key=staging,
                            Body=f,
                            ContentType=content_type,
                        )
                else:
                    log.info(
                        f"{self.kind}:{self.id} multipart "
                        f"{expected_size/1024/1024:.1f} MB -> {staging} "
                        f"(try {attempt}/{attempts})"
                    )
                    client.upload_file(
                        local_path, bucket, staging,
                        ExtraArgs={"ContentType": content_type},
                    )

                # Server-side copy → final key (atomic; readers see the new object).
                client.copy_object(
                    Bucket=bucket,
                    Key=key,
                    CopySource={"Bucket": bucket, "Key": staging},
                    ContentType=content_type,
                    MetadataDirective="REPLACE",
                )

                # VERIFY: head_object on final key and confirm size.
                # Catches silent truncation that boto3 sometimes swallows
                # on flaky networks.
                if expected_size > 0:
                    try:
                        head = client.head_object(Bucket=bucket, Key=key)
                        got = int(head.get("ContentLength") or 0)
                        if got != expected_size:
                            log.warning(
                                f"{self.kind}:{self.id} verify FAILED for {key}: "
                                f"expected {expected_size} bytes, got {got}. Will retry."
                            )
                            try:
                                client.delete_object(Bucket=bucket, Key=key)
                            except Exception:
                                pass
                            self._cleanup_staging(client, staging)
                            last_err = RuntimeError(
                                f"verify failed: expected {expected_size}, got {got}"
                            )
                            time.sleep(min(8.0, 1.5 ** attempt))
                            continue
                        log.info(f"{self.kind}:{self.id} verify OK: {got} bytes at {key}")
                    except Exception as e:
                        log.warning(
                            f"{self.kind}:{self.id} verify HEAD failed for {key}: {e}. "
                            f"Will retry."
                        )
                        self._cleanup_staging(client, staging)
                        last_err = e
                        time.sleep(min(8.0, 1.5 ** attempt))
                        continue

                # Success — clean up staging and return.
                try:
                    client.delete_object(Bucket=bucket, Key=staging)
                except Exception as _e:
                    log.debug(f"staging cleanup non-fatal: {_e}")

                return UploadResult(
                    public_url=self.public_url(key),
                    bytes_written=expected_size,
                    provider_id=self.id,
                    provider_kind=self.kind,
                )

            except RecursionError:
                log.error(
                    f"{self.kind}:{self.id} hit RecursionError on {key} "
                    f"({expected_size/1024/1024:.1f} MB) — likely "
                    f"urllib3/truststore SSL handshake recursion"
                )
                self._cleanup_staging(client, staging)
                last_err = RuntimeError(
                    f"RecursionError on {key} "
                    f"({expected_size/1024/1024:.1f} MB)"
                )
                time.sleep(min(8.0, 1.5 ** attempt))
                continue
            except Exception as e:
                self._cleanup_staging(client, staging)
                last_err = e
                time.sleep(min(8.0, 1.5 ** attempt))
                continue

        raise RuntimeError(
            f"{self.kind}:{self.id} upload failed for {key} after "
            f"{attempts} attempts: {last_err}"
        ) from last_err

    def _cleanup_staging(self, client, staging: str) -> None:
        """Best-effort: kill the staging object + abort any incomplete
        multipart uploads so we don't leave broken bytes."""
        try:
            client.delete_object(Bucket=self.config.bucket, Key=staging)
        except Exception:
            pass
        try:
            resp = client.list_multipart_uploads(
                Bucket=self.config.bucket, Prefix=staging,
            )
            for up in resp.get("Uploads", []) or []:
                try:
                    client.abort_multipart_upload(
                        Bucket=self.config.bucket,
                        Key=up["Key"],
                        UploadId=up["UploadId"],
                    )
                except Exception:
                    pass
        except Exception:
            pass

    # ── Other ops ──────────────────────────────────────────

    def delete(self, key: str) -> bool:
        try:
            self.client().delete_object(Bucket=self.config.bucket, Key=key)
            return True
        except Exception as e:
            log.warning(f"{self.kind}:{self.id} delete {key} failed: {e}")
            return False

    def public_url(self, key: str) -> str:
        base = (self.config.public_base or "").rstrip("/")
        return f"{base}/{key}" if base else ""

    def head(self, key: str) -> Optional[int]:
        try:
            head = self.client().head_object(Bucket=self.config.bucket, Key=key)
            return int(head.get("ContentLength") or 0)
        except Exception:
            return None

    def total_bytes(self, prefix: str = "") -> int:
        total = 0
        try:
            client = self.client()
            paginator = client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.config.bucket, Prefix=prefix):
                for obj in page.get("Contents", []) or []:
                    total += int(obj.get("Size") or 0)
        except Exception as e:
            log.debug(f"{self.kind}:{self.id} total_bytes failed: {e}")
        return total

    def health_check(self) -> tuple[bool, str]:
        try:
            self.client().head_bucket(Bucket=self.config.bucket)
            return True, f"bucket {self.config.bucket} reachable"
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
