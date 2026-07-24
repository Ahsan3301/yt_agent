/**
 * Password hashing + verification using Node's built-in scrypt.
 *
 * Chosen because:
 *   - Zero external deps (argon2/bcrypt would add a native build step).
 *   - Cross-language matches Python's hashlib.scrypt with the SAME params,
 *     so the Phase-1 migrate_to_multitenant.py script and this route
 *     produce byte-identical hashes.
 *   - OWASP-acceptable in 2025 with N=2^17, r=8, p=1 (~110 ms cost on
 *     modest hardware — matches bcrypt cost=12).
 *
 * Stored format:  scrypt$N$r$p$saltB64$hashB64
 * Salt: 16 random bytes. Hash: 64 bytes. All base64 (URL-unsafe standard).
 *
 * NEVER export the derived key. Verify via timingSafeEqual on the raw
 * buffers so wall-clock differences don't leak salt/hash length.
 */
import { scrypt as _scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scryptCb) as (
  password: string, salt: Buffer, keylen: number, options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

// Params picked to sit at ~100-200ms on a modern VPS core.
// N MUST be a power of 2. Never change these silently — a change here
// invalidates every stored hash. If you must upgrade parameters,
// version-tag the hash string ("scrypt2$...") and dual-verify.
const N = 1 << 17;   // 131_072 CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;

// Node's scrypt requires maxmem to accommodate N*r*128 bytes. Set to 2×
// the theoretical need (256 MB with these params). The Next.js server
// runtime has plenty of RAM — this only affects the per-hash allocation.
const MAX_MEM = 256 * 1024 * 1024;

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("hashPassword: empty plaintext");
  }
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(plaintext, salt, KEYLEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  if (typeof plaintext !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch { return false; }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(plaintext, salt, expected.length, { N: n, r, p, maxmem: MAX_MEM });
  } catch { return false; }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
