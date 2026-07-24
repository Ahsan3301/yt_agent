"""
One-shot idempotent migration script — bootstraps the multi-tenant
SaaS refactor's data model:

  1. Inserts three plan rows: founder (unlimited, for me), free
     (BYO-Kaggle skeleton), pro (shared-worker skeleton). Free/pro are
     inactive placeholders until Phase 5 fills them in.
  2. Inserts the founding user (id=u_founder, role=superadmin,
     status=active, plan_id=founder). Password comes from the
     FOUNDER_PASSWORD env var on FIRST run; on re-runs the existing
     hash is preserved unless FOUNDER_PASSWORD_RESET=1 is set.
  3. Backfills user_id="u_founder" onto every existing row of the 15
     tenant collections that migration 0013 added the column to.
  4. Dual-writes the singleton settings/api_keys and settings/default
     blobs into per-user shadows at settings/{u_founder}__api_keys
     and settings/{u_founder}__default — Phase 2 readers will fall
     back to the originals if the shadow is missing, so this write
     just primes the safety net.
  5. Flips settings/flags.auth_v2_enabled = true.

SAFE to run multiple times: every step is a check-then-write.

Requires: PB_URL_INTERNAL (or PB_URL) + POCKETBASE_ADMIN_EMAIL +
POCKETBASE_ADMIN_PASSWORD + FOUNDER_PASSWORD env vars.

Run inside the side-worker container (has all deps):
    docker exec <side-worker> python3 -m scripts.migrate_to_multitenant

Or locally with PB_URL pointing at the exposed endpoint.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
from typing import Any

import requests


# Self-contained _pb_id + passwords helpers so this script can be run
# standalone (SCP'd to the VPS host + `python3 migrate_to_multitenant.py`
# without the repo tree). Byte-identical to backend/db_pocketbase.py
# and backend/auth/passwords.py — do not diverge one without the other.

_VALID_PB_ID = re.compile(r"^[a-z0-9]{15}$")


def _pb_id(raw_id: str) -> str:
    raw = raw_id or ""
    if _VALID_PB_ID.match(raw):
        return raw
    h = hashlib.sha256(raw.encode("utf-8")).digest()
    b64 = base64.b64encode(h).decode("ascii").lower()
    stripped = "".join(c for c in b64 if c.isalnum())
    return stripped[:15]


_SCRYPT_N = 1 << 17
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_KEYLEN = 64
_SCRYPT_MAXMEM = 256 * 1024 * 1024


def _hash_password(plaintext: str) -> str:
    if not plaintext:
        raise ValueError("empty password")
    salt = secrets.token_bytes(16)
    d = hashlib.scrypt(plaintext.encode("utf-8"), salt=salt,
                       n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
                       maxmem=_SCRYPT_MAXMEM, dklen=_SCRYPT_KEYLEN)
    return (f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}"
            f"${base64.b64encode(salt).decode()}${base64.b64encode(d).decode()}")


class _passwords:
    hash_password = staticmethod(_hash_password)


passwords = _passwords()  # keep `passwords.hash_password(...)` call sites unchanged

PB_URL = (os.environ.get("PB_URL_INTERNAL") or os.environ.get("PB_URL") or "").rstrip("/")
ADMIN_EMAIL = os.environ.get("POCKETBASE_ADMIN_EMAIL", "")
ADMIN_PW = os.environ.get("POCKETBASE_ADMIN_PASSWORD", "")

FOUNDER_USER_ID = "u_founder"
FOUNDER_EMAIL = os.environ.get("FOUNDER_EMAIL", "nick@gjequip.ca")
FOUNDER_PLAN = "founder"

TENANT_COLLECTIONS = [
    "channels", "jobs", "runs_index", "run_summaries", "run_logs",
    "errors", "youtube_accounts", "storage_providers", "schedules",
    "api_keys", "backends", "queue_state", "idempotency",
    "cleanup_runs", "settings",
]

FLAGS_DOC_ID = "ktt7sdazit7wnsk"  # _pbId("flags") — set at migration 0016


# ────────────────────────────────────────────────────────────────
# PB helpers
# ────────────────────────────────────────────────────────────────
_tok: str | None = None


def _auth() -> str:
    global _tok
    if _tok:
        return _tok
    if not (PB_URL and ADMIN_EMAIL and ADMIN_PW):
        raise SystemExit(
            "Missing PB_URL_INTERNAL/PB_URL or POCKETBASE_ADMIN_EMAIL/PASSWORD env vars."
        )
    r = requests.post(
        f"{PB_URL}/api/collections/_superusers/auth-with-password",
        json={"identity": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=15,
    )
    r.raise_for_status()
    _tok = str(r.json().get("token") or "")
    if not _tok:
        raise SystemExit("PB admin login returned empty token")
    return _tok


def _hdr() -> dict[str, str]:
    return {"Authorization": _auth(), "Content-Type": "application/json"}


def _get(path: str) -> Any:
    r = requests.get(f"{PB_URL}{path}", headers=_hdr(), timeout=30)
    r.raise_for_status()
    return r.json()


def _post(path: str, body: dict) -> Any:
    r = requests.post(f"{PB_URL}{path}", headers=_hdr(), json=body, timeout=30)
    if r.status_code >= 400:
        raise SystemExit(f"POST {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def _patch(path: str, body: dict) -> Any:
    r = requests.patch(f"{PB_URL}{path}", headers=_hdr(), json=body, timeout=30)
    if r.status_code >= 400:
        raise SystemExit(f"PATCH {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def _try_get(path: str) -> Any | None:
    r = requests.get(f"{PB_URL}{path}", headers=_hdr(), timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


# ────────────────────────────────────────────────────────────────
# Steps
# ────────────────────────────────────────────────────────────────
def step_plans() -> None:
    print("[1/5] plans — ensuring founder + free + pro placeholders")
    now = int(time.time())
    plans = [
        {
            "slug": "founder", "name": "Founder (internal)",
            "price_monthly": 0, "price_yearly": 0,
            "max_channels": 0, "max_renders_month": 0,
            "shared_worker_access": True,
            "features": json.dumps({"unlimited": True, "operator": True}),
            "active": True, "sort_order": 0,
        },
        {
            "slug": "free", "name": "Free (BYO Kaggle)",
            "price_monthly": 0, "price_yearly": 0,
            "max_channels": 1, "max_renders_month": 30,
            "shared_worker_access": False,
            "features": json.dumps({"byo_worker": True}),
            "active": False, "sort_order": 10,  # inactive until Phase 5 finalises
        },
        {
            "slug": "pro", "name": "Pro (shared workers)",
            "price_monthly": 0, "price_yearly": 0,
            "max_channels": 5, "max_renders_month": 300,
            "shared_worker_access": True,
            "features": json.dumps({"shared_workers": True, "priority_queue": True}),
            "active": False, "sort_order": 20,
        },
    ]
    for p in plans:
        # Look up by slug (unique index in migration 0012).
        existing = _get(
            f"/api/collections/plans/records?perPage=1&filter=(slug='{p['slug']}')"
        )
        if existing.get("totalItems", 0) > 0:
            print(f"    plans/{p['slug']}: exists, skipping")
            continue
        _post("/api/collections/plans/records", p)
        print(f"    plans/{p['slug']}: created")


def step_founder_user() -> None:
    print("[2/5] app_users — ensuring founding user")
    # Convenience: if FOUNDER_PASSWORD isn't explicitly set, default to
    # the current DASHBOARD_PASSWORD env so the founder can log in
    # immediately with the same credentials they've been using. If the
    # dashboard password ever got leaked (e.g. the NIM key incident),
    # ROTATE the dashboard password AND run this script again with
    # FOUNDER_PASSWORD_RESET=1 to update the stored hash.
    fpw = (os.environ.get("FOUNDER_PASSWORD") or
           os.environ.get("DASHBOARD_PASSWORD") or "").strip()
    reset = os.environ.get("FOUNDER_PASSWORD_RESET") == "1"

    existing = _try_get(f"/api/collections/app_users/records/{FOUNDER_USER_ID}")
    if existing:
        # Optional password reset.
        if fpw and reset:
            _patch(f"/api/collections/app_users/records/{FOUNDER_USER_ID}",
                   {"password_hash": passwords.hash_password(fpw)})
            print(f"    app_users/{FOUNDER_USER_ID}: password RESET (FOUNDER_PASSWORD_RESET=1)")
        else:
            print(f"    app_users/{FOUNDER_USER_ID}: exists, skipping")
        return

    if not fpw:
        raise SystemExit(
            "First run — FOUNDER_PASSWORD env var required to create the founding user."
        )
    body = {
        "id": FOUNDER_USER_ID,
        "email": FOUNDER_EMAIL.strip().lower(),
        "password_hash": passwords.hash_password(fpw),
        "role": "superadmin",
        "status": "active",
        "plan_id": FOUNDER_PLAN,
        "created_at": int(time.time()),
    }
    _post("/api/collections/app_users/records", body)
    print(f"    app_users/{FOUNDER_USER_ID}: created (email={FOUNDER_EMAIL})")


def step_backfill_user_id() -> None:
    print("[3/5] backfilling user_id=u_founder on 15 tenant collections")
    for coll in TENANT_COLLECTIONS:
        # Paginate over rows where user_id is empty/null; PATCH each.
        # PB doesn't support UPDATE-WHERE via REST; we page + patch.
        # Filter: user_id="" OR user_id=null — but PB filters on empty
        # text is `user_id=""`. Missing/null values will match either
        # depending on driver; try both progressively.
        try:
            page = 1
            patched = 0
            while True:
                r = _get(
                    f"/api/collections/{coll}/records"
                    f"?perPage=200&page={page}&filter=(user_id=''||user_id=null)"
                )
                items = r.get("items", [])
                if not items:
                    break
                for rec in items:
                    _patch(f"/api/collections/{coll}/records/{rec['id']}",
                           {"user_id": FOUNDER_USER_ID})
                    patched += 1
                if len(items) < 200:
                    break
                page += 1
            print(f"    {coll}: patched {patched} row(s)")
        except SystemExit as e:
            print(f"    {coll}: SKIPPED (filter error, likely missing collection): {e}")


def step_shadow_settings() -> None:
    print("[4/5] shadowing singleton settings blobs into per-user versions")
    # Source ids (from _pbId hash of "api_keys" and "default").
    for src_name in ("api_keys", "default"):
        src_id = _pb_id(src_name)
        src = _try_get(f"/api/collections/settings/records/{src_id}")
        if not src:
            print(f"    settings/{src_id} ({src_name}): missing, skipping shadow")
            continue
        shadow_id = _pb_id(f"{FOUNDER_USER_ID}__{src_name}")
        shadow = _try_get(f"/api/collections/settings/records/{shadow_id}")
        if shadow:
            print(f"    settings/{shadow_id} ({FOUNDER_USER_ID}__{src_name}): exists, skipping")
            continue
        body = {
            "id": shadow_id,
            "data": src.get("data"),
            "updated_at": int(time.time()),
            "user_id": FOUNDER_USER_ID,
        }
        _post("/api/collections/settings/records", body)
        print(f"    settings/{shadow_id}: created shadow of {src_name}")


def step_flip_auth_v2() -> None:
    print("[5/5] flipping settings/flags.auth_v2_enabled = true")
    row = _try_get(f"/api/collections/settings/records/{FLAGS_DOC_ID}")
    if not row:
        raise SystemExit(
            f"flags row {FLAGS_DOC_ID} missing — did Phase 0 migration 0016 run?"
        )
    data = row.get("data")
    if isinstance(data, str):
        data = json.loads(data)
    if not isinstance(data, dict):
        data = {}
    if data.get("auth_v2_enabled") is True:
        print("    already true, skipping")
        return
    data["auth_v2_enabled"] = True
    _patch(f"/api/collections/settings/records/{FLAGS_DOC_ID}", {
        "data": json.dumps(data),
        "updated_at": int(time.time()),
    })
    print("    auth_v2_enabled: true")


def main() -> int:
    print("=== migrate_to_multitenant.py ===")
    print(f"    PB_URL:  {PB_URL}")
    print(f"    admin:   {ADMIN_EMAIL}")
    print(f"    founder: {FOUNDER_EMAIL} (id={FOUNDER_USER_ID})")
    print()
    step_plans()
    step_founder_user()
    step_backfill_user_id()
    step_shadow_settings()
    step_flip_auth_v2()
    print()
    print("=== DONE — founder can now log in with email + FOUNDER_PASSWORD ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
