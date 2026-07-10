/**
 * Oracle unlock password: scrypt hash + timing-safe compare.
 *
 * The Oracle side-worker gets ONE shared unlock password via env
 * (ORACLE_UNLOCK_PASSWORD). Each channel that wants to use Oracle stores
 * a hash of that password on its channel doc — set/replace/clear via the
 * /channels edit form, never viewable.
 *
 * At claim time, the Oracle worker sends the plain password in the claim
 * body; the /api/jobs/claim gate calls verifyOraclePassword(plain, hash)
 * against each candidate job's stored hash.
 *
 * Format: "scrypt$<hex-salt>$<hex-hash>" — self-describing so we can
 * swap algorithms later without a data migration.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export function hashOraclePassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyOraclePassword(plain: string, stored: string): boolean {
  try {
    if (!stored || !plain) return false;
    const parts = stored.split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = scryptSync(plain, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
