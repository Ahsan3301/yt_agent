"""Cloudflare R2 provider.

R2 uses an account-id-derived endpoint (https://<account>.r2.cloudflarestorage.com)
and the magic region name "auto". Public URLs come from the r2.dev
subdomain you enable on the bucket, OR a custom domain — both are
captured in ProviderConfig.public_base.

The account ID is stashed in ProviderConfig.extras["account_id"] when
the user fills the R2 form on /storage. If config.endpoint is already
a full URL (someone pasting it directly), we honor that too.
"""
from __future__ import annotations
from .s3_like import S3LikeProvider


class R2Provider(S3LikeProvider):
    DEFAULT_REGION = "auto"

    def _resolve_endpoint(self) -> str:
        if self.config.endpoint:
            # User pasted a full endpoint — use it verbatim.
            return self.config.endpoint
        account_id = (self.config.extras or {}).get("account_id", "").strip()
        if account_id:
            return f"https://{account_id}.r2.cloudflarestorage.com"
        return ""

    def _path_style(self) -> bool:
        # R2 supports both styles; path-style is more permissive
        # (works with custom domains lacking SSL on the wildcard).
        return True
