"""
StorageProvider — abstract base for every storage destination.

Concrete providers (MinIO, R2, AWS S3, Wasabi, B2, Hostinger SFTP) each
expose the same four operations: put a file at a given key, fetch its
public URL, delete it, and check if a key exists.

ProviderConfig is the dataclass the registry hydrates from a
storage_providers/<id> Pocketbase doc. Keeping it explicit means we
can validate the shape without ad-hoc dict access.

UploadResult carries enough info for the facade to record video_url,
verify the byte count, and surface storage-tier info in /health.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)


# Provider kinds the registry understands. The string values match the
# `kind` field on Pocketbase storage_providers docs AND the dropdown
# options in web/app/storage/page.tsx — keep them in sync.
PROVIDER_KINDS = ("minio", "r2", "aws_s3", "wasabi", "b2", "hostinger_sftp")


@dataclass
class ProviderConfig:
    """Hydrated form of a Pocketbase storage_providers/<id> doc.

    `name` is user-facing ("My R2 backup"). `kind` selects the
    concrete provider class. The rest are kind-specific; not every
    field is set on every provider — see each subclass for what it
    actually reads. Unused fields default to empty strings so the
    config is uniform in shape.
    """
    id: str
    name: str
    kind: str  # one of PROVIDER_KINDS

    # ── S3-like fields ─────────────────────────────────────
    endpoint: str = ""                # e.g. https://s3.us-east-005.backblazeb2.com
    bucket: str = ""
    region: str = "auto"              # boto3 region (R2 likes "auto", AWS S3 likes "us-east-1")
    access_key_id: str = ""           # plaintext after registry decrypts
    secret_access_key: str = ""       # plaintext after registry decrypts
    public_base: str = ""             # URL prefix at which uploaded files are publicly readable
    path_style: bool = True           # path-style addressing (true for MinIO, false for AWS-prod)

    # ── SFTP-specific ──────────────────────────────────────
    host: str = ""
    port: int = 22
    user: str = ""
    password: str = ""                # plaintext after registry decrypts
    base_dir: str = ""

    # ── Bookkeeping ────────────────────────────────────────
    is_primary: bool = False
    is_mirror: bool = False
    enabled: bool = True

    # Provider-specific extras (kept as a dict so we don't have to add
    # a field every time a new provider gains a knob).
    extras: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.kind not in PROVIDER_KINDS:
            raise ValueError(
                f"Unknown provider kind: {self.kind!r}. "
                f"Expected one of {PROVIDER_KINDS}."
            )


@dataclass
class UploadResult:
    """Returned by StorageProvider.put_file. Records the public URL +
    actual byte count the destination reports back (after verify), so
    callers can confirm upload integrity without re-HEADing themselves."""
    public_url: str
    bytes_written: int
    provider_id: str
    provider_kind: str


class StorageProvider(ABC):
    """Every concrete provider subclasses this.

    Provider instances are CACHED by the registry — one instance per
    storage_providers/<id> doc, reused across uploads. So clients
    (boto3, paramiko) are reused too.

    Failure semantics: put_file raises on any error after exhausting
    its own retries. The facade catches; mirror provider failures are
    logged but never fatal.
    """

    def __init__(self, config: ProviderConfig) -> None:
        self.config = config

    @property
    def id(self) -> str:
        return self.config.id

    @property
    def kind(self) -> str:
        return self.config.kind

    @property
    def name(self) -> str:
        return self.config.name

    # ── Required operations ────────────────────────────────

    @abstractmethod
    def put_file(self, key: str, local_path: str, content_type: str) -> UploadResult:
        """Upload local_path to `key` at this provider. Must verify
        the byte count post-upload and retry on mismatch. Raises on
        terminal failure."""

    @abstractmethod
    def delete(self, key: str) -> bool:
        """Delete the object at `key`. Returns True iff something
        was actually removed."""

    @abstractmethod
    def public_url(self, key: str) -> str:
        """Return the publicly readable URL for `key`. Empty string
        when the provider has no public-base configured."""

    @abstractmethod
    def head(self, key: str) -> Optional[int]:
        """Return the byte size at `key`, or None if missing."""

    # ── Optional — providers can override ───────────────────

    def total_bytes(self, prefix: str = "") -> int:
        """Sum of all object sizes under prefix. Used by /health and
        the migration check. Default implementation returns 0 — providers
        without a list-objects implementation can leave it that way."""
        return 0

    def health_check(self) -> tuple[bool, str]:
        """Cheap connectivity probe. Returns (ok, message). Default:
        try head() on a synthetic key. Providers can override with
        something faster."""
        try:
            self.head("__health_probe_should_not_exist__")
            return True, "ok"
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
