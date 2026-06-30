"""AWS S3 provider.

Region matters here — unlike R2/MinIO, AWS S3 endpoints are region-
specific. ProviderConfig.region MUST be set to the bucket's region.
If config.endpoint is left empty, we derive it from the region.

Public URL: prefer config.public_base when set (custom domain or
CloudFront); otherwise fall back to the bucket-website pattern.
"""
from __future__ import annotations
from .s3_like import S3LikeProvider


class AwsS3Provider(S3LikeProvider):
    DEFAULT_REGION = "us-east-1"

    def _resolve_endpoint(self) -> str:
        if self.config.endpoint:
            return self.config.endpoint
        region = self._resolve_region()
        return f"https://s3.{region}.amazonaws.com"

    def _path_style(self) -> bool:
        # AWS S3 is moving away from path-style; honour the explicit
        # config flag (default False on AWS) so virtual-host addressing
        # is used in modern setups.
        return bool(self.config.path_style)

    def public_url(self, key: str) -> str:
        if self.config.public_base:
            return f"{self.config.public_base.rstrip('/')}/{key}"
        # Fall back to virtual-host-style URL.
        return f"https://{self.config.bucket}.s3.{self._resolve_region()}.amazonaws.com/{key}"
