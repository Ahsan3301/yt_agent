#!/usr/bin/env python3
"""
firestore_to_pocketbase.py — one-shot Firestore → Pocketbase migrator.

Idempotent: re-run safely as a "delta sync" before final cutover to
catch writes that happened during the migration window. Existing
Pocketbase records are UPDATED (matched by Firestore doc id stored in
the Pocketbase `firestore_id` synthetic field).

Usage:
    # Set Firestore credentials.
    export GOOGLE_APPLICATION_CREDENTIALS_JSON='{...service account JSON...}'

    # Set Pocketbase admin credentials.
    export PB_URL=https://your-domain.example.com/pb
    export PB_ADMIN_EMAIL=admin@your-domain.example.com
    export PB_ADMIN_PASSWORD=...

    # Dry-run first.
    python scripts/firestore_to_pocketbase.py --dry-run

    # When happy, run for real.
    python scripts/firestore_to_pocketbase.py

    # Limit to specific collections (e.g. just channels + youtube_accounts).
    python scripts/firestore_to_pocketbase.py --only channels,youtube_accounts

    # Skip a collection.
    python scripts/firestore_to_pocketbase.py --skip run_logs

Notes:
  - The runs_index/<id>/logs subcollection in Firestore is FLATTENED
    here into the run_logs Pocketbase collection (with a run_id field).
    Same data, schemaless query becomes `run_id == X`.
  - Pocketbase auto-generates 15-char ids. To preserve Firestore ids
    we set them explicitly via the special `id` field on each record.
    Pocketbase accepts any string up to 15 chars matching ^[a-z0-9]+$.
    Firestore ids that don't match get hashed to a deterministic
    15-char base32 derivative — original retained in `firestore_id`.
  - Pocketbase rejects unknown fields by default — every Firestore
    field is mapped to a known schema field or stuffed into a JSON
    catch-all (`doc` for settings/queue_state/schedules).
  - Timestamps: Firestore returns datetime objects; Pocketbase wants
    epoch seconds. Conversion is automatic.

Verify counts after running:
    python scripts/firestore_to_pocketbase.py --counts-only
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import sys
import time
from typing import Any, Iterable, Optional

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("migrate")


# ── Collection mapping ────────────────────────────────────────────
# Firestore → Pocketbase. Subcollections are handled below.
COLLECTIONS = [
    "jobs",
    "backends",
    "channels",
    "youtube_accounts",
    "api_keys",
    "settings",
    "runs_index",
    "run_summaries",
    "errors",
    "queue_state",
    "idempotency",
    "schedules",
    "storage_providers",
]


# Pocketbase id format: 15 chars, [a-z0-9]+. We try to preserve the
# original Firestore id where it fits; otherwise hash to fit.
_VALID_PB_ID = re.compile(r"^[a-z0-9]{15}$")


def _to_pb_id(firestore_id: str) -> str:
    """Either reuse the Firestore id verbatim (if it fits PB's format)
    or derive a deterministic 15-char base32 id from it."""
    fid = (firestore_id or "").lower()
    if _VALID_PB_ID.match(fid):
        return fid
    # Hash → base32 → first 15 chars.
    h = hashlib.sha256(firestore_id.encode("utf-8")).digest()
    b32 = base64.b32encode(h).decode("ascii").lower().replace("=", "")
    # Strip any chars PB might still reject (b32 is a-z2-7).
    return b32[:15]


def _to_epoch(v: Any) -> Optional[float]:
    """Convert various timestamp shapes to epoch seconds."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    # Firestore returns google.cloud.firestore_v1.base_document.DatetimeWithNanoseconds
    if hasattr(v, "timestamp"):
        return v.timestamp()
    if hasattr(v, "isoformat"):
        # Best-effort: parse ISO string back to epoch.
        try:
            from datetime import datetime
            return datetime.fromisoformat(v.isoformat()).timestamp()
        except Exception:
            return None
    return None


# ── Per-collection record transformers ────────────────────────────
# Each takes a Firestore doc dict + firestore_id, returns a dict ready
# for Pocketbase POST. The "id" key is added by the bulk writer.
#
# Schemaless collections (settings, queue_state, schedules) stuff the
# entire doc into a `doc` JSON field — see the schema in
# 0001_initial_schema.js.

def _transform_default(d: dict, fid: str) -> dict:
    """Generic — pass through, converting timestamps to epoch."""
    out = {}
    for k, v in d.items():
        # Skip Firestore-side timestamps we don't have a schema column for.
        if k in ("created_at", "updated_at"):
            continue
        epoch = _to_epoch(v)
        if epoch is not None and isinstance(v, (int, float)) is False:
            out[k] = epoch
        else:
            out[k] = v
    return out


def _transform_jobs(d: dict, fid: str) -> dict:
    out = _transform_default(d, fid)
    # Firestore stored queued_at/started_at/finished_at as floats already.
    # No further conversion needed.
    return out


def _transform_backends(d: dict, fid: str) -> dict:
    out = _transform_default(d, fid)
    # last_seen_at sometimes stored as Firestore SERVER_TIMESTAMP.
    if isinstance(d.get("last_seen_at"), (int, float)) is False:
        out["last_seen_at"] = _to_epoch(d.get("last_seen_at")) or 0
    return out


def _transform_schemaless(d: dict, fid: str) -> dict:
    """For settings, queue_state, schedules — wrap the whole doc."""
    return {"doc": _serialise_nested(d)}


def _serialise_nested(v: Any) -> Any:
    """Recursively turn Firestore types into JSON-friendly values."""
    if isinstance(v, dict):
        return {k: _serialise_nested(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_serialise_nested(x) for x in v]
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    # Datetimes → ISO string.
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            return str(v)
    return str(v)


def _transform_run_summary(d: dict, fid: str) -> dict:
    """run_summaries — whole doc into `doc` JSON column, plus run_id."""
    return {"run_id": fid, "doc": _serialise_nested(d)}


TRANSFORMERS = {
    "jobs":              _transform_jobs,
    "backends":          _transform_backends,
    "channels":          _transform_default,
    "youtube_accounts":  _transform_default,
    "api_keys":          _transform_default,
    "settings":          _transform_schemaless,
    "queue_state":       _transform_schemaless,
    "schedules":         _transform_schemaless,
    "runs_index":        _transform_default,
    "run_summaries":     _transform_run_summary,
    "errors":            _transform_default,
    "idempotency":       _transform_default,
    "storage_providers": _transform_default,
}


# ── Firestore reader ──────────────────────────────────────────────

def _firestore_client():
    import google.cloud.firestore as _fs
    raw = os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not raw:
        raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise RuntimeError(
            "Set GOOGLE_APPLICATION_CREDENTIALS_JSON (or FIREBASE_SERVICE_ACCOUNT_JSON) "
            "to the contents of your Firebase service account JSON."
        )
    info = json.loads(raw) if isinstance(raw, str) else raw
    creds = _credentials_from_dict(info)
    return _fs.Client(project=info.get("project_id"), credentials=creds)


def _credentials_from_dict(info: dict):
    from google.oauth2 import service_account
    return service_account.Credentials.from_service_account_info(info)


def _stream_collection(client, name: str) -> Iterable[tuple[str, dict]]:
    """Yield (firestore_id, dict) per doc. Streams to avoid loading
    huge collections (errors, run_logs) into memory."""
    for snap in client.collection(name).stream():
        yield snap.id, (snap.to_dict() or {})


def _stream_run_logs_subcollections(client) -> Iterable[tuple[str, str, dict]]:
    """Special handler for runs_index/<id>/logs/<log_id> → flat
    run_logs records with run_id field.

    Yields (firestore_log_id, run_id, log_doc_dict).
    """
    for run_snap in client.collection("runs_index").stream():
        run_id = run_snap.id
        try:
            for log_snap in run_snap.reference.collection("logs").stream():
                yield log_snap.id, run_id, (log_snap.to_dict() or {})
        except Exception as e:
            log.warning("run %s: failed to stream logs subcoll: %s", run_id, e)


# ── Pocketbase writer ─────────────────────────────────────────────

class PocketBaseClient:
    def __init__(self, url: str, email: str, password: str) -> None:
        self.url = url.rstrip("/")
        self._token = self._auth(email, password)

    def _auth(self, email: str, password: str) -> str:
        import requests
        r = requests.post(
            f"{self.url}/api/admins/auth-with-password",
            json={"identity": email, "password": password},
            timeout=15,
        )
        if not r.ok:
            raise RuntimeError(
                f"Pocketbase admin auth failed: HTTP {r.status_code} — {r.text[:200]}"
            )
        return r.json()["token"]

    def _headers(self) -> dict:
        return {"Authorization": self._token, "Content-Type": "application/json"}

    def upsert(self, collection: str, record_id: str, record: dict) -> bool:
        """Try to update by id; if 404, create. Returns True on success."""
        import requests
        body = {**record, "id": record_id}

        # PATCH first.
        r = requests.patch(
            f"{self.url}/api/collections/{collection}/records/{record_id}",
            json=body,
            headers=self._headers(),
            timeout=30,
        )
        if r.status_code == 200:
            return True
        if r.status_code != 404:
            log.warning("PATCH %s/%s -> %s: %s", collection, record_id, r.status_code, r.text[:200])
            return False

        # 404 → CREATE.
        r = requests.post(
            f"{self.url}/api/collections/{collection}/records",
            json=body,
            headers=self._headers(),
            timeout=30,
        )
        if r.status_code in (200, 201):
            return True
        log.warning("POST %s -> %s: %s", collection, r.status_code, r.text[:200])
        return False

    def count(self, collection: str) -> int:
        import requests
        r = requests.get(
            f"{self.url}/api/collections/{collection}/records",
            params={"perPage": 1, "page": 1},
            headers=self._headers(),
            timeout=15,
        )
        if r.ok:
            return int(r.json().get("totalItems") or 0)
        return -1


# ── Main migration loop ───────────────────────────────────────────

def _migrate_collection(fs_client, pb: PocketBaseClient, name: str,
                        dry_run: bool) -> tuple[int, int]:
    """Returns (read, written)."""
    transform = TRANSFORMERS.get(name, _transform_default)
    read = 0
    written = 0
    for fid, doc in _stream_collection(fs_client, name):
        read += 1
        pb_id = _to_pb_id(fid)
        record = transform(doc, fid)
        # Tag with Firestore id for traceability.
        record.setdefault("firestore_id", fid)
        if dry_run:
            if read <= 3:
                log.info("  [dry] %s/%s ← Firestore id=%s", name, pb_id, fid)
            continue
        if pb.upsert(name, pb_id, record):
            written += 1
        else:
            log.warning("  upsert failed for %s/%s", name, fid)
        if written % 100 == 0 and written > 0:
            log.info("  %s: %d/%d written...", name, written, read)
    return read, written


def _migrate_run_logs(fs_client, pb: PocketBaseClient, dry_run: bool) -> tuple[int, int]:
    """runs_index/<id>/logs subcollection → flat run_logs collection."""
    read = 0
    written = 0
    for log_fid, run_id, doc in _stream_run_logs_subcollections(fs_client):
        read += 1
        record = {
            "run_id":          run_id,
            "ts":              _to_epoch(doc.get("ts")) or 0,
            "level":           doc.get("level") or "info",
            "msg":             (doc.get("msg") or "")[:4000],
            "req_id":          doc.get("req_id") or "",
            "firestore_id":    log_fid,
        }
        pb_id = _to_pb_id(f"{run_id}_{log_fid}")
        if dry_run:
            if read <= 3:
                log.info("  [dry] run_logs/%s ← runs_index/%s/logs/%s", pb_id, run_id, log_fid)
            continue
        if pb.upsert("run_logs", pb_id, record):
            written += 1
        if written % 500 == 0 and written > 0:
            log.info("  run_logs: %d/%d written...", written, read)
    return read, written


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="don't write to Pocketbase; just count + show samples")
    ap.add_argument("--only", default="",
                    help="comma-separated collection names to include "
                         "(default: all)")
    ap.add_argument("--skip", default="",
                    help="comma-separated collection names to skip")
    ap.add_argument("--counts-only", action="store_true",
                    help="just print Firestore vs Pocketbase counts side by side")
    args = ap.parse_args()

    selected = set(c.strip() for c in args.only.split(",") if c.strip()) or set(COLLECTIONS + ["run_logs"])
    skipped = set(c.strip() for c in args.skip.split(",") if c.strip())
    targets = [c for c in COLLECTIONS + ["run_logs"] if c in selected and c not in skipped]

    log.info("Connecting to Firestore...")
    fs = _firestore_client()
    log.info("Connecting to Pocketbase at %s...", os.getenv("PB_URL"))
    pb = PocketBaseClient(
        url=os.getenv("PB_URL") or "",
        email=os.getenv("PB_ADMIN_EMAIL") or "",
        password=os.getenv("PB_ADMIN_PASSWORD") or "",
    )

    if args.counts_only:
        log.info("%-22s %10s %10s", "collection", "firestore", "pocketbase")
        log.info("-" * 50)
        for c in targets:
            try:
                if c == "run_logs":
                    fcount = sum(1 for _ in _stream_run_logs_subcollections(fs))
                else:
                    fcount = sum(1 for _ in fs.collection(c).stream())
                pcount = pb.count(c)
                log.info("%-22s %10d %10d", c, fcount, pcount)
            except Exception as e:
                log.warning("count %s: %s", c, e)
        return

    log.info("Migrating %d collections (%s)%s",
             len(targets), ", ".join(targets), " [DRY RUN]" if args.dry_run else "")
    grand_read = 0
    grand_written = 0
    t0 = time.time()
    for c in targets:
        ts = time.time()
        if c == "run_logs":
            r, w = _migrate_run_logs(fs, pb, args.dry_run)
        else:
            r, w = _migrate_collection(fs, pb, c, args.dry_run)
        log.info("→ %-22s read=%d written=%d in %.1fs",
                 c, r, w, time.time() - ts)
        grand_read += r
        grand_written += w
    log.info("DONE. read=%d written=%d total=%.1fs",
             grand_read, grand_written, time.time() - t0)


if __name__ == "__main__":
    main()
