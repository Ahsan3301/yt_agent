"""
Pocketbase-backed shim exposing the same call shape as Firestore's
Python Admin SDK.

Routes and modules call:
  db.client().collection("jobs").document(jid).set({...})
  db.client().collection("backends").stream()
  db.client().collection("channels").document(id).delete()
  ts = db.server_timestamp()

When DB_BACKEND=pocketbase, the client() returned by backend.db is an
instance of `PocketBaseClient` defined here, with the same surface as
google.cloud.firestore.Client used by the legacy path. The shim is
narrow in scope — only the operations our code actually uses are
implemented, not the full Firestore Admin surface.

Auth: PB_URL + PB_SERVER_TOKEN env vars. PB_URL_INTERNAL (docker
network hostname) is preferred when set, falling back to PB_URL.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from typing import Any, Iterator, Optional

import requests

log = logging.getLogger(__name__)


# Sentinel mapped to epoch-seconds at write time. Routes use this via
# backend.db.server_timestamp() so they don't import firestore.
class _ServerTimestampSentinel:
    def __repr__(self) -> str:
        return "<SERVER_TIMESTAMP>"


SERVER_TIMESTAMP = _ServerTimestampSentinel()


_VALID_PB_ID = re.compile(r"^[a-z0-9]{15}$")


def _pb_id(raw_id: str) -> str:
    """Pocketbase ids: 15 chars [a-z0-9]+. Reuse if it fits, else hash."""
    raw = (raw_id or "").lower()
    if _VALID_PB_ID.match(raw):
        return raw
    h = hashlib.sha256(raw_id.encode("utf-8")).digest()
    import base64 as _b64
    b32 = _b64.b32encode(h).decode("ascii").lower().replace("=", "")
    return b32[:15]


def _serialise(value: Any) -> Any:
    """Substitute server-timestamp sentinels with epoch seconds at write
    time. Recurses into dicts so nested timestamps (rare but possible)
    are handled too."""
    if isinstance(value, _ServerTimestampSentinel):
        return time.time()
    if isinstance(value, dict):
        return {k: _serialise(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_serialise(v) for v in value]
    return value


def _strip_pb_fields(rec: dict) -> dict:
    """Hide PB-internal fields so callers see Firestore-shape dicts."""
    out = dict(rec)
    for k in ("collectionId", "collectionName", "created", "updated", "expand"):
        out.pop(k, None)
    return out


def _filter_value(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "\\'")
    return f"'{s}'"


def _filter_expr(field: str, op: str, value: Any) -> str:
    v = _filter_value(value)
    if op == "==":
        return f"{field} = {v}"
    if op == "!=":
        return f"{field} != {v}"
    if op == "<":
        return f"{field} < {v}"
    if op == "<=":
        return f"{field} <= {v}"
    if op == ">":
        return f"{field} > {v}"
    if op == ">=":
        return f"{field} >= {v}"
    if op == "in" and isinstance(value, (list, tuple)):
        return "(" + " || ".join(f"{field} = {_filter_value(x)}" for x in value) + ")"
    if op == "array-contains":
        return f"{field} ~ {v}"
    raise ValueError(f"Unsupported filter op: {op}")


# ── Doc + Collection ──────────────────────────────────────────────


class _DocSnapshot:
    def __init__(self, *, exists: bool, doc_id: str, data: Optional[dict], ref: "DocumentReference"):
        self.exists = exists
        self.id = doc_id
        self._data = data
        self.reference = ref

    def to_dict(self) -> Optional[dict]:
        return self._data


class DocumentReference:
    def __init__(self, client: "PocketBaseClient", collection: str, doc_id: str):
        self._client = client
        self._collection = collection
        self._raw_id = doc_id
        self._pb_id = _pb_id(doc_id)

    @property
    def id(self) -> str:
        return self._raw_id

    @property
    def path(self) -> str:
        return f"{self._collection}/{self._raw_id}"

    def get(self) -> _DocSnapshot:
        r = self._client._http(
            "GET",
            f"/api/collections/{self._collection}/records/{self._pb_id}",
        )
        if r.status_code == 404:
            return _DocSnapshot(exists=False, doc_id=self._raw_id, data=None, ref=self)
        if not r.ok:
            raise RuntimeError(f"PB get {self.path}: HTTP {r.status_code}: {r.text[:200]}")
        return _DocSnapshot(
            exists=True,
            doc_id=self._raw_id,
            data=_strip_pb_fields(r.json()),
            ref=self,
        )

    def set(self, data: dict, merge: bool = False) -> None:
        body = {**_serialise(data), "id": self._pb_id}
        # PATCH first when merge=True; else try PATCH and fall back.
        url = f"/api/collections/{self._collection}/records/{self._pb_id}"
        r = self._client._http("PATCH", url, json=body)
        if r.status_code == 404:
            r2 = self._client._http(
                "POST",
                f"/api/collections/{self._collection}/records",
                json=body,
            )
            if not r2.ok:
                raise RuntimeError(f"PB create {self.path}: HTTP {r2.status_code}: {r2.text[:200]}")
            return
        if not r.ok:
            raise RuntimeError(f"PB set {self.path}: HTTP {r.status_code}: {r.text[:200]}")

    def update(self, data: dict) -> None:
        r = self._client._http(
            "PATCH",
            f"/api/collections/{self._collection}/records/{self._pb_id}",
            json=_serialise(data),
        )
        if not r.ok:
            raise RuntimeError(f"PB update {self.path}: HTTP {r.status_code}: {r.text[:200]}")

    def delete(self) -> None:
        r = self._client._http(
            "DELETE",
            f"/api/collections/{self._collection}/records/{self._pb_id}",
        )
        if not r.ok and r.status_code != 404:
            raise RuntimeError(f"PB delete {self.path}: HTTP {r.status_code}")

    def collection(self, name: str) -> "CollectionReference":
        """Subcollection — PB doesn't support these natively. We surface
        a flat collection with the parent's id baked into queries.

        Used for runs_index/<run_id>/logs in the legacy code. The
        migrator + new write path flatten these into a top-level
        `run_logs` collection with a `run_id` field. The shim here
        just returns a query pre-filtered by run_id."""
        # Map runs_index/<id>/logs → run_logs filtered by run_id.
        if self._collection == "runs_index" and name == "logs":
            ref = CollectionReference(self._client, "run_logs")
            ref._auto_filter = ("run_id", "==", self._raw_id)
            return ref
        raise NotImplementedError(
            f"subcollection {self.path}/{name} not mapped for Pocketbase"
        )

    def collection_root(self) -> "CollectionReference":
        return CollectionReference(self._client, self._collection)


class _Query:
    def __init__(self, client: "PocketBaseClient", collection: str):
        self._client = client
        self._collection = collection
        self._filters: list[str] = []
        self._sort: list[str] = []
        self._limit = 0
        self._auto_filter: Optional[tuple[str, str, Any]] = None

    def where(self, field: str, op: str, value: Any) -> "_Query":
        self._filters.append(_filter_expr(field, op, value))
        return self

    def order_by(self, field: str, direction: str = "ASCENDING") -> "_Query":
        dir_char = "-" if direction.upper().startswith("DESC") else "+"
        self._sort.append(dir_char + field)
        return self

    def limit(self, n: int) -> "_Query":
        self._limit = max(1, min(500, n))
        return self

    def stream(self) -> Iterator[_DocSnapshot]:
        # Paginate transparently. PB caps perPage at 500.
        params: dict = {"perPage": min(500, self._limit or 500), "page": 1}
        filters = list(self._filters)
        if self._auto_filter:
            f, op, v = self._auto_filter
            filters.append(_filter_expr(f, op, v))
        if filters:
            params["filter"] = " && ".join(filters)
        if self._sort:
            params["sort"] = ",".join(self._sort)
        yielded = 0
        while True:
            r = self._client._http(
                "GET",
                f"/api/collections/{self._collection}/records",
                params=params,
            )
            if not r.ok:
                raise RuntimeError(f"PB query {self._collection}: HTTP {r.status_code}: {r.text[:200]}")
            data = r.json()
            for rec in data.get("items", []):
                yield _DocSnapshot(
                    exists=True,
                    doc_id=str(rec.get("id", "")),
                    data=_strip_pb_fields(rec),
                    ref=DocumentReference(self._client, self._collection, str(rec.get("id", ""))),
                )
                yielded += 1
                if self._limit and yielded >= self._limit:
                    return
            if data.get("page", 1) >= data.get("totalPages", 1):
                return
            params["page"] = int(data.get("page", 1)) + 1

    def get(self) -> list[_DocSnapshot]:
        return list(self.stream())


class CollectionReference(_Query):
    def __init__(self, client: "PocketBaseClient", name: str):
        super().__init__(client, name)
        self.id = name

    def document(self, doc_id: str) -> DocumentReference:
        return DocumentReference(self._client, self._collection, doc_id)


# ── Top-level client ──────────────────────────────────────────────


class PocketBaseClient:
    """Surface matches what google.cloud.firestore.Client exposes for
    the operations our codebase actually uses.

    Auth: superuser login via POCKETBASE_ADMIN_EMAIL/PASSWORD on first
    use, cached for 1 hour (PB tokens last ~30 days; refresh hourly to
    be safe). PB doesn't support pre-issued static service tokens.
    """

    def __init__(self, url: str, token: str):
        self._url = url.rstrip("/")
        # token kept for future API parity but unused — PB has no
        # static service-token concept yet.
        self._unused_token = token
        self._session = requests.Session()
        self._auth_token: Optional[str] = None
        self._auth_expires_at: float = 0.0
        self._admin_email = os.getenv("POCKETBASE_ADMIN_EMAIL", "")
        self._admin_password = os.getenv("POCKETBASE_ADMIN_PASSWORD", "")

    def _get_auth_token(self) -> str:
        import time as _time
        if self._auth_token and _time.time() < self._auth_expires_at:
            return self._auth_token
        if not self._admin_email or not self._admin_password:
            raise RuntimeError(
                "Pocketbase auth not configured — set "
                "POCKETBASE_ADMIN_EMAIL + POCKETBASE_ADMIN_PASSWORD"
            )
        r = self._session.post(
            f"{self._url}/api/collections/_superusers/auth-with-password",
            json={"identity": self._admin_email, "password": self._admin_password},
            timeout=15,
        )
        if not r.ok:
            raise RuntimeError(
                f"Pocketbase superuser auth failed: HTTP {r.status_code} — {r.text[:200]}"
            )
        token = (r.json() or {}).get("token") or ""
        if not token:
            raise RuntimeError("Pocketbase auth response missing token")
        self._auth_token = token
        # 30-day token; refresh hourly to be safe.
        self._auth_expires_at = _time.time() + 3600
        return token

    def _http(self, method: str, path: str, **kwargs) -> requests.Response:
        kwargs.setdefault("timeout", 30)
        headers = kwargs.pop("headers", None) or {}
        headers.setdefault("Authorization", self._get_auth_token())
        return self._session.request(method, f"{self._url}{path}", headers=headers, **kwargs)

    def collection(self, name: str) -> CollectionReference:
        return CollectionReference(self, name)
