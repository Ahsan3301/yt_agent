"""Wasabi provider. S3-compatible, region-specific endpoints, no egress fees.

Endpoints follow https://s3.<region>.wasabisys.com.
"""
from __future__ import annotations
from .s3_like import S3LikeProvider


class WasabiProvider(S3LikeProvider):
    DEFAULT_REGION = "us-east-1"

    def _resolve_endpoint(self) -> str:
        if self.config.endpoint:
            return self.config.endpoint
        return f"https://s3.{self._resolve_region()}.wasabisys.com"
