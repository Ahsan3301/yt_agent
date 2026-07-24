/**
 * Server-side auth helpers used by API routes.
 *
 * `readSession(req)` — parses the dash_auth cookie via the shared
 * `verifySession` helper. Returns null if missing/invalid/expired.
 *
 * `requireUser(req)` — throws-shaped helper for API routes. Returns
 * `{userId, role, impersonating}` OR returns a NextResponse 401 for
 * the caller to `return`. Cleaner call sites than checking null
 * everywhere.
 *
 * `findAppUserByEmail(email)` — server-side lookup for the login route.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { verifySession, type Session } from "@/lib/session";

const COOKIE_NAME = "dash_auth";

export async function readSession(req: NextRequest | Request): Promise<Session | null> {
  const cookieHeader = (req as NextRequest).cookies?.get?.(COOKIE_NAME)?.value
    ?? _parseCookieHeader((req as Request).headers.get?.("cookie") || "", COOKIE_NAME);
  if (!cookieHeader) return null;
  return verifySession(cookieHeader);
}

export type RequireUserResult =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse };

export async function requireUser(req: NextRequest | Request): Promise<RequireUserResult> {
  const session = await readSession(req);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorised" }, { status: 401 }),
    };
  }
  return { ok: true, session };
}

/** Server-side app_users lookup by email. */
export async function findAppUserByEmail(email: string): Promise<Record<string, unknown> | null> {
  const clean = (email || "").trim().toLowerCase();
  if (!clean) return null;
  try {
    const snap = await adminDb().collection("app_users")
      .where("email", "==", clean).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ...(doc.data() as Record<string, unknown>) };
  } catch {
    return null;
  }
}

/** Fallback parser for the raw `Cookie` header. Used when the request
 *  object isn't a NextRequest (e.g. edge runtimes returning bare
 *  Request). */
function _parseCookieHeader(header: string, name: string): string {
  if (!header) return "";
  const parts = header.split(";").map((s) => s.trim());
  const needle = `${name}=`;
  for (const p of parts) {
    if (p.startsWith(needle)) return decodeURIComponent(p.slice(needle.length));
  }
  return "";
}
