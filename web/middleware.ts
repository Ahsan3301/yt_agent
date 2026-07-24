import { NextRequest, NextResponse } from "next/server";
import { verifySession, signSession, sessionSecret } from "@/lib/session";

/**
 * Next.js middleware — runs on every request.
 *
 * Two responsibilities:
 *   1. Request-ID propagation for end-to-end log correlation.
 *   2. Auth gate on every page + API route, unless the path is public
 *      or uses X-API-Key (worker/cron server-to-server).
 *
 * Auth model (v2 — Phase 1 of the SaaS refactor):
 *   - Cookie `dash_auth` carries a v2 payload `v2:<userId>:<role>:<expiry>[:imp]`
 *     signed with SESSION_SECRET (falls back to DASHBOARD_PASSWORD).
 *   - Legacy `v1:<expiry>` cookies still verify (issued when a caller
 *     logs in via the master-password branch). They resolve to a
 *     synthetic founder session (see lib/session.ts::verifySession).
 *   - On valid auth we set `x-user-id`, `x-user-role`, and
 *     `x-session-legacy` request headers for downstream route handlers.
 *   - Role gates for /admin/* + /superadmin/* land in Phase 3;
 *     middleware today only checks presence + validity.
 *
 * Signup landing (/signup) is added to the public bypass so Phase 4's
 * public flow works. The route itself gates on the signup_open flag.
 */
const PUBLIC_PATHS = new Set([
  // Marketing pages — anyone can hit these.
  "/",
  "/pricing",
  "/features",
  "/login",
  "/signup",
  // Auth endpoints the login/signup forms POST to.
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/register",
  "/api/preflight",
]);

// API routes that use their own X-API-Key auth (worker↔dashboard).
const API_KEY_ROUTES: string[] = [
  "/api/workers/register",
  "/api/jobs/claim",
  "/api/maintenance/",
  "/api/backends/wake-kaggle",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Request-ID propagation (unchanged).
  const existing = req.headers.get("x-request-id");
  const reqId = existing && existing.length >= 6 ? existing : _genId();
  const resHeaders = new Headers(req.headers);
  resHeaders.set("x-request-id", reqId);

  // Auth is enabled iff a session secret is configured (SESSION_SECRET
  // or DASHBOARD_PASSWORD). Cleared env = open dev mode.
  const secret = sessionSecret();
  if (secret) {
    const isPublic =
      PUBLIC_PATHS.has(pathname) ||
      pathname.startsWith("/_next/") ||
      pathname.startsWith("/favicon");
    const isApiKeyRoute = API_KEY_ROUTES.some((p) => pathname.startsWith(p));
    if (!isPublic && !isApiKeyRoute) {
      const cookie = req.cookies.get("dash_auth")?.value || "";
      const session = cookie ? await verifySession(cookie) : null;
      if (!session) {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json({ error: "unauthorised" }, { status: 401 });
        }
        const url = req.nextUrl.clone();
        url.pathname = "/login";
        url.searchParams.set("next", pathname);
        return NextResponse.redirect(url);
      }
      // Attach identity headers so route handlers can inspect them
      // without re-parsing the cookie. Route filters in Phase 2 read
      // x-user-id off this.
      resHeaders.set("x-user-id", session.userId);
      resHeaders.set("x-user-role", session.role);
      if (session.legacy) resHeaders.set("x-session-legacy", "1");
      if (session.impersonating) resHeaders.set("x-session-impersonating", "1");

      // Role gates (Phase 3). Layouts also enforce these via a
      // server-side check, but the middleware bounce is friendlier —
      // gives a clean redirect instead of a mid-render throw.
      if (pathname.startsWith("/admin") &&
          session.role !== "admin" && session.role !== "superadmin") {
        const url = req.nextUrl.clone();
        url.pathname = "/app";
        return NextResponse.redirect(url);
      }
      if (pathname.startsWith("/superadmin") && session.role !== "superadmin") {
        const url = req.nextUrl.clone();
        url.pathname = "/app";
        return NextResponse.redirect(url);
      }
    }
  }

  const res = NextResponse.next({ request: { headers: resHeaders } });
  res.headers.set("x-request-id", reqId);
  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

function _genId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Legacy export — the current login route imports this. Kept as a
 *  thin re-export around the new session helper so existing callers
 *  don't break during the Phase-1 dual-auth window. */
export async function _signSession(payload: string, secret: string): Promise<string> {
  return signSession(payload, secret);
}
