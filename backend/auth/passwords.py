"""
Password hashing + verification — byte-identical output to
web/lib/passwords.ts so the JS login route and this Python module can
verify each other's hashes.

Algorithm: scrypt with N=131072 (2^17), r=8, p=1, keylen=64.
Stored format: scrypt$N$r$p$saltB64$hashB64  (standard base64, url-unsafe)
Salt: 16 random bytes.

Only stdlib (hashlib.scrypt + secrets + base64 + hmac) — no external deps.
This is the SAME algorithm and parameter tuple used by the TypeScript
side; do not change one without changing the other.
"""
from __future__ import annotations
import base64
import hmac
import hashlib
import os
import secrets

N = 1 << 17          # 131_072 CPU/memory cost
R = 8
P = 1
KEYLEN = 64
SALT_LEN = 16

# hashlib.scrypt's `maxmem` is a hard cap on how much RAM it will
# allocate; must be >= 128 * N * r bytes. 256 MB covers the picked
# params with a 2x safety margin.
_MAXMEM = 256 * 1024 * 1024


def hash_password(plaintext: str) -> str:
    if not isinstance(plaintext, str) or not plaintext:
        raise ValueError("hash_password: empty plaintext")
    salt = secrets.token_bytes(SALT_LEN)
    derived = hashlib.scrypt(
        plaintext.encode("utf-8"),
        salt=salt, n=N, r=R, p=P, maxmem=_MAXMEM, dklen=KEYLEN,
    )
    salt_b64 = base64.b64encode(salt).decode("ascii")
    hash_b64 = base64.b64encode(derived).decode("ascii")
    return f"scrypt${N}${R}${P}${salt_b64}${hash_b64}"


def verify_password(plaintext: str, stored: str) -> bool:
    if not isinstance(plaintext, str) or not isinstance(stored, str):
        return False
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    try:
        n = int(parts[1]); r = int(parts[2]); p = int(parts[3])
    except (TypeError, ValueError):
        return False
    try:
        salt = base64.b64decode(parts[4])
        expected = base64.b64decode(parts[5])
    except Exception:
        return False
    if not salt or not expected:
        return False
    try:
        derived = hashlib.scrypt(
            plaintext.encode("utf-8"),
            salt=salt, n=n, r=r, p=p, maxmem=_MAXMEM, dklen=len(expected),
        )
    except Exception:
        return False
    # Constant-time compare — hmac.compare_digest doesn't allocate an
    # intermediate string like `derived == expected` would.
    return hmac.compare_digest(derived, expected)


if __name__ == "__main__":
    # Tiny self-test — verify a round-trip. Useful when landing on a
    # fresh worker: `python -m backend.auth.passwords` prints OK.
    pw = os.environ.get("_TEST_PW", "correct horse battery staple")
    h = hash_password(pw)
    assert verify_password(pw, h), "self-test: verify failed"
    assert not verify_password(pw + "x", h), "self-test: bad pw accepted"
    print("passwords: self-test OK")
