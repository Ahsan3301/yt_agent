/**
 * Tenant filter helpers for Phase 2 of the SaaS refactor.
 *
 * Every non-bypass API route calls `getTenant(req)` to resolve the
 * caller's user context. Reads inject `.where("user_id", "==", userId)`
 * only when the `tenant_filter_enforced` flag is on AND the caller
 * isn't a superadmin (who sees everything). Writes always stamp
 * `user_id` so rows created today survive when the flag flips on later.
 *
 * Behaviour summary:
 *   flag OFF, any role   -> stamps writes; reads unfiltered (legacy)
 *   flag ON,  user/admin -> stamps writes; reads filtered by user_id
 *   flag ON,  superadmin -> stamps writes with THEIR own id; reads unfiltered
 *
 * The route handler is responsible for:
 *   - calling `assertOwnership(row, tenant)` after every `.doc(id).get()`
 *     it wants to enforce cross-tenant isolation on (rejects with 404).
 *   - composing `tenant.where` into any list query alongside the route's
 *     own filters, using `.where(...)` chaining.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifySession, type UserRole, FOUNDER_USER_ID } from "@/lib/session";
import { getFlag } from "@/lib/flags";

export interface Tenant {
  userId: string;
  role: UserRole;
  isSuper: boolean;
  /** True when tenant filtering is actually being enforced for this
   *  request (flag on AND caller not superadmin). Route handlers can
   *  short-circuit when false. */
  enforce: boolean;
  /** True while auth_v2_enabled=true is not yet flipped, or when the
   *  session was resolved from a legacy v1 cookie. Kept for logging. */
  legacy: boolean;
  impersonating: boolean;
}

const COOKIE = "dash_auth";

/** Read the session and compute enforcement mode. Prefers request
 *  headers set by middleware (avoids re-parsing the cookie); falls
 *  back to parsing directly for handlers invoked outside the
 *  middleware chain (rare — mainly tests). */
export async function getTenant(req: NextRequest | Request): Promise<Tenant | null> {
  // Prefer middleware-injected headers.
  const uidHdr = (req.headers.get("x-user-id") || "").trim();
  const roleHdr = (req.headers.get("x-user-role") || "").trim() as UserRole;
  const legacyHdr = req.headers.get("x-session-legacy") === "1";
  const impHdr = req.headers.get("x-session-impersonating") === "1";

  let userId = uidHdr;
  let role: UserRole = roleHdr;
  let legacy = legacyHdr;
  let impersonating = impHdr;

  if (!userId || !role) {
    // Cookie fallback.
    const cookieVal = (req as NextRequest).cookies?.get?.(COOKIE)?.value
      ?? _parseCookieHeader(req.headers.get("cookie") || "", COOKIE);
    const session = cookieVal ? await verifySession(cookieVal) : null;
    if (!session) return null;
    userId = session.userId;
    role = session.role;
    legacy = session.legacy;
    impersonating = session.impersonating;
  }

  const isSuper = role === "superadmin";
  const flagOn = await getFlag("tenant_filter_enforced");

  return {
    userId,
    role,
    isSuper,
    enforce: flagOn && !isSuper,
    legacy,
    impersonating,
  };
}

/** Require an authenticated tenant. Returns either { tenant } or
 *  { response } — the response is a 401 the route should return. */
export async function requireTenant(
  req: NextRequest | Request,
): Promise<{ tenant: Tenant } | { response: NextResponse }> {
  const tenant = await getTenant(req);
  if (!tenant) {
    return { response: NextResponse.json({ error: "unauthorised" }, { status: 401 }) };
  }
  return { tenant };
}

/** Post-fetch ownership guard. Call after a `.doc(id).get()` on any
 *  tenant collection. Rejects with 404 (not 403 — hides existence of
 *  cross-tenant rows) when the row belongs to another tenant. Returns
 *  null when the row is owned OR ownership isn't being enforced. */
export function assertOwnership(
  rowData: Record<string, unknown> | undefined,
  tenant: Tenant,
): NextResponse | null {
  if (!rowData) return null;
  if (!tenant.enforce) return null;
  const owner = String(rowData.user_id || "");
  if (owner && owner === tenant.userId) return null;
  // Row has no owner (pre-Phase-1 backfill) OR belongs to someone else.
  // The Phase-1 backfill sets user_id on every row, so an unowned row
  // at this point is either brand new + about-to-be-stamped, or a bug.
  // Either way, non-owning tenant sees 404.
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/** Compose a user_id filter for list queries. Returns [] when not
 *  enforcing, so callers can do:
 *      let q = db.collection("jobs").where("status", "==", "queued");
 *      for (const [f, op, v] of tenant.whereClauses("jobs"))
 *          q = q.where(f, op, v);
 */
export function tenantWhereClauses(tenant: Tenant): Array<[string, "==", string]> {
  if (!tenant.enforce) return [];
  return [["user_id", "==", tenant.userId]];
}

/** Stamp user_id on a write payload. Idempotent — if the payload
 *  already has user_id (e.g. the founder's row created pre-Phase-1),
 *  it isn't overwritten. */
export function stampUserId<T extends Record<string, unknown>>(
  payload: T, tenant: Tenant,
): T & { user_id?: string } {
  if ("user_id" in payload && payload.user_id) return payload;
  return { ...payload, user_id: tenant.userId };
}

/** Convenience: the founder id, exported so route handlers can compare
 *  without importing from lib/session directly. */
export const FOUNDER = FOUNDER_USER_ID;

function _parseCookieHeader(header: string, name: string): string {
  if (!header) return "";
  const parts = header.split(";").map((s) => s.trim());
  const needle = `${name}=`;
  for (const p of parts) if (p.startsWith(needle)) return decodeURIComponent(p.slice(needle.length));
  return "";
}
