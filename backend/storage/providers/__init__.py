"""Storage provider implementations.

Every concrete provider subclasses StorageProvider (in base.py). The
registry instantiates whichever one matches a `storage_providers/<id>`
Pocketbase doc's `kind` field.
"""
from .base import StorageProvider, ProviderConfig, UploadResult

__all__ = ["StorageProvider", "ProviderConfig", "UploadResult"]
