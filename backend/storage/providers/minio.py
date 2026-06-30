"""MinIO provider. Self-hosted S3-compatible store on the Coolify stack.

Quirks:
  - path-style addressing is mandatory (no DNS virtual-host setup).
  - region is ignored by MinIO but boto3 wants something; "us-east-1"
    is the conventional placeholder.
  - public URLs route through Caddy at /s3/<bucket>/<key>.
"""
from __future__ import annotations
from .s3_like import S3LikeProvider


class MinIOProvider(S3LikeProvider):
    DEFAULT_REGION = "us-east-1"

    def _path_style(self) -> bool:
        return True  # always path-style for MinIO
