/**
 * Session cookie helpers — v2 (user-bound) with v1 (single-password)
 * legacy fallback.
 *
 * Cookie name stays `dash_auth`. Payload formats:
 *   v1:<expiryMs>                     — legacy, synthetic founder session
 *   v2:<userId>:<role>:<expiryMs>     — new, real user session
 *   v2:<userId>:<role>:<expiryMs>:imp — impersonation (superadmin acting
 *                                        as another user; every write is
 *                                        logged to audit_log)
 * Both formats are HMAC-SHA256 signed (`<payload>.<sigB64>`).
 *
 * Secret: SESSION_SECRET env var if set (SaaS-mode), else falls back to
 * DASHBOARD_PASSWORD (single-user legacy mode) so no env change is
 * required to deploy Phase 1 alongside Phase 0.
 *
 * All exports run in the Edge (middleware) + Node runtimes — they use
 * only Web Crypto APIs (crypto.subtle), no Node-specific imports.
 */

export type UserRole = "user" | "admin" | "superadmin";

export interface Session {
  userId: string;
  role: UserRole;
  expiresAt: number;
  impersonating: boolean;
  /** True if this session was resolved from a v1 legacy cookie. */
  legacy: boolean;
}

const COOKIE_TTL_DAYS = 30;
export const COOKIE_MAX_AGE_SECONDS = COOKIE_TTL_DAYS * 24 * 3600;

/** The synthetic user id every v1 cookie resolves to. */
export const FOUNDER_USER_ID = "u_founder";

export function sessionSecret(): string {
  return (process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || "").trim();
}

async function _hmacB64Url(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const arr = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign a `<payload>.<hmac>` token. */
export async function signSession(payload: string, secret: string): Promise<string> {
  const sig = await _hmacB64Url(payload, secret);
  return `${payload}.${sig}`;
}

/** Create a v2 (user-bound) session cookie value. */
export async function signSessionV2(
  userId: string, role: UserRole, opts: { impersonating?: boolean; ttlMs?: number } = {},
): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("session secret missing (SESSION_SECRET or DASHBOARD_PASSWORD)");
  const ttl = opts.ttlMs ?? COOKIE_MAX_AGE_SECONDS * 1000;
  const expiryMs = Date.now() + ttl;
  const parts = ["v2", userId, role, String(expiryMs)];
  if (opts.impersonating) parts.push("imp");
  return signSession(parts.join(":"), secret);
}

/** Create a v1 (legacy single-password) session cookie value. Only
 *  called by the legacy branch of the login route; kept for
 *  backward-compat during the Phase 1→2 window. */
export async function signSessionV1(): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("session secret missing");
  const expiryMs = Date.now() + COOKIE_MAX_AGE_SECONDS * 1000;
  return signSession(`v1:${expiryMs}`, secret);
}

/** Parse and verify any session cookie. Returns null on any failure
 *  (bad format, bad signature, expired). Does NOT throw. */
export async function verifySession(cookieValue: string): Promise<Session | null> {
  if (!cookieValue) return null;
  const secret = sessionSecret();
  if (!secret) return null;

  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = cookieValue.slice(0, idx);
  const expected = await signSession(payload, secret);
  if (expected !== cookieValue) return null;

  const parts = payload.split(":");
  if (parts.length < 2) return null;
  const version = parts[0];

  if (version === "v1") {
    // v1:<expiryMs> — legacy, synthetic founder session.
    if (parts.length !== 2) return null;
    const expiry = Number(parts[1]);
    if (!Number.isFinite(expiry) || Date.now() >= expiry) return null;
    return {
      userId: FOUNDER_USER_ID,
      role: "superadmin",
      expiresAt: expiry,
      impersonating: false,
      legacy: true,
    };
  }

  if (version === "v2") {
    // v2:<userId>:<role>:<expiryMs>[:imp]
    if (parts.length < 4 || parts.length > 5) return null;
    const userId = parts[1];
    const role = parts[2] as UserRole;
    const expiry = Number(parts[3]);
    const impersonating = parts.length === 5 && parts[4] === "imp";
    if (!userId || !["user", "admin", "superadmin"].includes(role)) return null;
    if (!Number.isFinite(expiry) || Date.now() >= expiry) return null;
    return { userId, role, expiresAt: expiry, impersonating, legacy: false };
  }

  return null;
}
