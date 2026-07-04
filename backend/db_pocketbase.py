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


# Subcollection → flat collection mapping. Firestore allows
# `db.collection("runs_index").document("<run>").collection("logs")` to
# write nested children; PB has no subcollections, so we route those
# writes to a flat top-level collection with a foreign-key field.
#
# Format: ("parent_collection", "child_name") → ("flat_collection",
#                                                "fk_field")
_SUBCOLLECTION_MAP = {
    ("runs_index", "logs"): ("run_logs", "run_id"),
}


def _pb_id(raw_id: str) -> str:
    """Pocketbase ids: 15 chars [a-z0-9]+. Reuse if it fits, else hash.

    MUST match web/lib/pocketbase-admin.ts _pbId() byte-for-byte —
    otherwise the TS route writes to one PB id and the Python worker
    reads from another. Cross-language mismatch was the reason NIM
    keys saved via the dashboard weren't seen on the worker.

    Algorithm: sha256(rawId) → base64 → lowercase → strip non-alphanum
    → take first 15 chars. Same as Node's createHash.digest('base64').
    """
    # Match JS _pbId() byte-for-byte: the pre-check must run on the
    # RAW input (case-sensitive). Previously Python lowercased first,
    # so an all-uppercase 15-char alphanumeric id was returned as
    # lowercase here while JS returned it as-is and used it verbatim,
    # producing two different PB doc ids for the same logical id.
    # Never bites our timestamp run_ids (they contain underscores and
    # fall to the hash branch) but bites any 15-char-clean input.
    raw = raw_id or ""
    if _VALID_PB_ID.match(raw):
        return raw
    import base64 as _b64
    h = hashlib.sha256(raw_id.encode("utf-8")).digest()
    b64 = _b64.b64encode(h).decode("ascii").lower()
    # Strip anything not [a-z0-9] — matches the JS regex /[^a-z0-9]/g.
    b64 = "".join(c for c in b64 if c.isalnum())
    return b64[:15]


def _generate_auto_id() -> str:
    """Generate a 15-char PB-valid id. Used when callers do
    `.document()` with no id (Firestore auto-id semantics)."""
    import secrets
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(15))


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
        # Inherited from CollectionReference._auto_inject when this doc
        # came from a subcollection-mapped parent (e.g. runs_index/<id>/logs
        # → write injects run_id=<id> automatically).
        self._auto_inject: dict[str, Any] = {}

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
        body = {**self._auto_inject, **_serialise(data), "id": self._pb_id}
        # PATCH first; on 404 try POST create; if THAT hits a
        # unique-index conflict (an older row under a different PB id
        # but same run_id/name field), find the offending row by the
        # conflicted field and PATCH it. Was previously bubbling
        # 'validation_not_unique' up and dropping the write entirely.
        url = f"/api/collections/{self._collection}/records/{self._pb_id}"
        r = self._client._http("PATCH", url, json=body)
        if r.status_code == 404:
            r2 = self._client._http(
                "POST",
                f"/api/collections/{self._collection}/records",
                json=body,
            )
            if r2.ok:
                return
            # Unique-index conflict recovery. PB returns:
            #   {"data": {"<field>": {"code":"validation_not_unique", ...}}}
            try:
                import json as _json
                err = _json.loads(r2.text or "{}")
                dup_fields = list((err.get("data") or {}).keys())
            except Exception:
                dup_fields = []
            if r2.status_code == 400 and dup_fields:
                for fld in dup_fields:
                    val = body.get(fld)
                    if not val:
                        continue
                    # Look up the row that already occupies this
                    # unique-field slot, then PATCH it.
                    q = self._client._http(
                        "GET",
                        f"/api/collections/{self._collection}/records",
                        params={"filter": f"{fld}='{str(val)}'", "perPage": 1},
                    )
                    if q.ok:
                        items = (q.json() or {}).get("items") or []
                        if items:
                            existing_id = items[0].get("id")
                            if existing_id:
                                patch_body = {k: v for k, v in body.items() if k != "id"}
                                r3 = self._client._http(
                                    "PATCH",
                                    f"/api/collections/{self._collection}/records/{existing_id}",
                                    json=patch_body,
                                )
                                if r3.ok:
                                    return
                                raise RuntimeError(
                                    f"PB unique-conflict recovery PATCH failed: "
                                    f"HTTP {r3.status_code}: {r3.text[:200]}"
                                )
            raise RuntimeError(f"PB create {self.path}: HTTP {r2.status_code}: {r2.text[:200]}")
        if not r.ok:
            raise RuntimeError(f"PB set {self.path}: HTTP {r.status_code}: {r.text[:200]}")

    def update(self, data: dict) -> None:
        payload = {**self._auto_inject, **_serialise(data)}
        r = self._client._http(
            "PATCH",
            f"/api/collections/{self._collection}/records/{self._pb_id}",
            json=payload,
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
        a flat collection with the parent's id auto-injected on writes
        AND auto-filtered on reads.

        Used by backend/logbuf.py for runs_index/<run_id>/logs. The
        flat collection has a `run_id` foreign-key field; any read
        from this ref filters by it, any write injects it."""
        mapping = _SUBCOLLECTION_MAP.get((self._collection, name))
        if mapping is None:
            raise NotImplementedError(
                f"subcollection {self.path}/{name} not mapped for Pocketbase. "
                f"Add to _SUBCOLLECTION_MAP."
            )
        flat_coll, fk_field = mapping
        ref = CollectionReference(self._client, flat_coll)
        # Read filter — automatically applied to stream/get.
        ref._auto_filter = (fk_field, "==", self._raw_id)
        # Write injection — set/add on this ref will include this field.
        ref._auto_inject = {fk_field: self._raw_id}
        return ref

    def collection_root(self) -> "CollectionReference":
        return CollectionReference(self._client, self._collection)


class _Query:
    def __init__(self, client: "PocketBaseClient", collection: str):
        self._client = client
        self._collection = collection
        self._filters: list[str] = []
        self._sort: list[str] = []
        self._limit = 0
        # For subcollection-mapped refs: auto-filter on reads.
        self._auto_filter: Optional[tuple[str, str, Any]] = None
        # For subcollection-mapped refs: auto-inject these fields on
        # every write (set/update) made via .document() under this ref.
        self._auto_inject: dict[str, Any] = {}

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

    def count(self) -> "_CountAggregator":
        """Firestore-style aggregation. .count().get() returns
        AggregateQuerySnapshot with .data() containing 'count'."""
        return _CountAggregator(self)


class _CountAggregator:
    """Mimics Firestore's CountAggregate. PB has no native count API
    yet, so we do a per_page=1 query and read totalItems from the
    response — O(1) cost."""

    def __init__(self, query: "_Query"):
        self._query = query

    def get(self) -> "_CountSnapshot":
        q = self._query
        params: dict = {"perPage": 1, "page": 1}
        filters = list(q._filters)
        if q._auto_filter:
            f, op, v = q._auto_filter
            filters.append(_filter_expr(f, op, v))
        if filters:
            params["filter"] = " && ".join(filters)
        r = q._client._http(
            "GET",
            f"/api/collections/{q._collection}/records",
            params=params,
        )
        if not r.ok:
            return _CountSnapshot(0)
        data = r.json()
        return _CountSnapshot(int(data.get("totalItems") or 0))


class _CountSnapshot:
    def __init__(self, count: int):
        self._count = count

    def data(self) -> dict:
        return {"count": self._count}


class CollectionReference(_Query):
    def __init__(self, client: "PocketBaseClient", name: str):
        super().__init__(client, name)
        self.id = name

    def document(self, doc_id: Optional[str] = None) -> DocumentReference:
        """Get a doc ref. With no id → auto-generates a 15-char id
        (Firestore parity). With id → uses it verbatim if it fits PB's
        format, hashes otherwise."""
        if doc_id is None or doc_id == "":
            doc_id = _generate_auto_id()
        ref = DocumentReference(self._client, self._collection, doc_id)
        # If this collection ref had an auto_inject (it came from
        # parent.collection("subcol")), the resulting doc inherits it.
        if self._auto_inject:
            ref._auto_inject = dict(self._auto_inject)
        return ref


# ── Top-level client ──────────────────────────────────────────────


class _Batch:
    """Emulates google.cloud.firestore.WriteBatch. PB has no native
    batch endpoint — we accumulate ops and flush them on commit().
    NOT atomic (parallel HTTP calls); matches our wrapper's overall
    'best-effort batch' semantics. Acceptable for log/event writes;
    NOT acceptable for primary-promotion invariants — those should
    use serial awaits + their own rollback logic.
    """

    def __init__(self, client: "PocketBaseClient"):
        self._client = client
        self._ops: list[tuple[str, "DocumentReference", dict | None]] = []

    def set(self, ref: "DocumentReference", data: dict, merge: bool = False):
        self._ops.append(("set", ref, data))
        return self

    def update(self, ref: "DocumentReference", data: dict):
        self._ops.append(("update", ref, data))
        return self

    def delete(self, ref: "DocumentReference"):
        self._ops.append(("delete", ref, None))
        return self

    def commit(self):
        from concurrent.futures import ThreadPoolExecutor, as_completed
        if not self._ops:
            return
        # Cap parallelism so we don't open hundreds of sockets.
        with ThreadPoolExecutor(max_workers=8) as ex:
            futures = []
            for op, ref, data in self._ops:
                if op == "set":
                    futures.append(ex.submit(ref.set, data))
                elif op == "update":
                    futures.append(ex.submit(ref.update, data))
                elif op == "delete":
                    futures.append(ex.submit(ref.delete))
            errors = []
            for f in as_completed(futures):
                try:
                    f.result()
                except Exception as e:
                    errors.append(e)
            if errors:
                # Surface the first one; the others are logged at op level.
                raise errors[0]
        self._ops.clear()


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

    def batch(self) -> "_Batch":
        """Firestore-compat WriteBatch. Use for log/event writes (no
        atomicity guarantee — see _Batch docstring)."""
        return _Batch(self)
