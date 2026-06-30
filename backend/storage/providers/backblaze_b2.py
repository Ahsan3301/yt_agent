"""Backblaze B2 provider via the S3-compatible API.

B2 endpoints look like https://s3.us-east-005.backblazeb2.com — the
suffix is region-specific. ProviderConfig.region holds the region
string ("us-east-005", "eu-central-003", etc.).

Public URL is the friendly URL Backblaze hands you when you make a
bucket "public" — captured in public_base.
"""
from __future__ import annotations
from .s3_like import S3LikeProvider


class BackblazeB2Provider(S3LikeProvider):
    DEFAULT_REGION = "us-east-005"

    def _resolve_endpoint(self) -> str:
        if self.config.endpoint:
            return self.config.endpoint
        return f"https://s3.{self._resolve_region()}.backblazeb2.com"
