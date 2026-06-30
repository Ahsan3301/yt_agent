/**
 * AES-256-GCM symmetric encryption for storage provider secrets.
 *
 * Mirrors backend/storage/crypto.py — same key, same format
 * ("v1:base64(nonce|ciphertext|tag)") so secrets written from the
 * dashboard decrypt correctly on the Python worker side, and vice
 * versa.
 *
 * Key source: STORAGE_PROVIDERS_ENC_KEY env var (server-only, never
 * shipped to the client). When unset, we fall back to "b64:" prefix
 * + base64 — secure ENOUGH for local dev, NOT FOR PRODUCTION (logged
 * loudly in that case).
 */
import { webcrypto as nodeCrypto } from "node:crypto";

// The node:crypto webcrypto export is structurally identical to the
// browser's Web Crypto API but TypeScript's lib.dom and node types
// don't share a CryptoKey definition. The casts below are safe — both
// surfaces implement the same W3C spec.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const crypto = nodeCrypto as any;

const KEY_ENV = "STORAGE_PROVIDERS_ENC_KEY";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _keyCache: any = null;
let _keyChecked = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _key(): Promise<any> {
  if (_keyChecked) return _keyCache;
  _keyChecked = true;

  const raw = (process.env[KEY_ENV] || "").trim();
  if (!raw) return null;

  let kb: Uint8Array;
  try {
    if (/^[0-9a-fA-F]+$/.test(raw)) {
      // Hex (preferred — matches `openssl rand -hex 32`).
      kb = new Uint8Array(raw.length / 2);
      for (let i = 0; i < raw.length; i += 2) {
        kb[i / 2] = parseInt(raw.substr(i, 2), 16);
      }
    } else {
      kb = new Uint8Array(Buffer.from(raw, "base64"));
    }
  } catch (e) {
    console.error(`${KEY_ENV} is set but not parseable:`, e);
    return null;
  }
  if (kb.length !== 32) {
    console.error(`${KEY_ENV} must be 32 bytes (got ${kb.length})`);
    return null;
  }

  _keyCache = await crypto.subtle.importKey(
    "raw",
    kb,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return _keyCache;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext) return "";
  const key = await _key();
  if (!key) {
    console.warn(
      `${KEY_ENV} not configured — storing provider secret as base64 only ` +
      `(NOT secure; set this env var in production)`,
    );
    return "b64:" + Buffer.from(plaintext, "utf-8").toString("base64");
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  const blob = new Uint8Array(nonce.length + ct.byteLength);
  blob.set(nonce, 0);
  blob.set(new Uint8Array(ct), nonce.length);
  return "v1:" + Buffer.from(blob).toString("base64");
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  if (!ciphertext) return "";
  if (ciphertext.startsWith("b64:")) {
    return Buffer.from(ciphertext.slice(4), "base64").toString("utf-8");
  }
  if (!ciphertext.startsWith("v1:")) {
    // Legacy / unprefixed — treat as plaintext.
    return ciphertext;
  }
  const key = await _key();
  if (!key) {
    throw new Error(`Encrypted secret found but ${KEY_ENV} is not set`);
  }
  const blob = new Uint8Array(Buffer.from(ciphertext.slice(3), "base64"));
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ct,
  );
  return new TextDecoder().decode(pt);
}

/** UI-side masking: show only the last `keep` chars. Never round-trip
 * a masked value back to the server. */
export function maskSecret(s: string, keep = 4): string {
  if (!s) return "";
  if (s.length <= keep) return "*".repeat(s.length);
  return "*".repeat(s.length - keep) + s.slice(-keep);
}
