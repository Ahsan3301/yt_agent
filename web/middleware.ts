import { NextRequest, NextResponse } from "next/server";

/**
 * Next.js middleware — runs on every request.
 *
 * Two responsibilities:
 *   1. Request-ID propagation for end-to-end log correlation (unchanged
 *      from the original — dashboard ↔ worker traceability).
 *   2. Password gate on every page + API route. Set DASHBOARD_PASSWORD
 *      env var to enable. Cleared env var = no auth (dev mode).
 *
 * Auth model:
 *   - User posts password to /api/auth/login → server verifies against
 *     DASHBOARD_PASSWORD → sets a signed cookie (`dash_auth`).
 *   - Middleware checks the cookie on every subsequent request.
 *   - Cookie is HttpOnly + Secure + SameSite=Lax so it survives
 *     iframe embeds (Colab/Kaggle previews) but resists CSRF.
 *   - Allowed unauthenticated: /login (the form itself),
 *     /api/auth/login (the POST target), /api/auth/logout (clears
 *     cookie), /api/preflight (public liveness), /api/workers/register
 *     + /api/jobs/claim (worker-facing, protected by X-API-Key).
 */
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/preflight",
]);

// API routes that use their own X-API-Key auth (worker↔dashboard) —
// these bypass the cookie check because they're server-to-server.
const API_KEY_ROUTES: string[] = [
  "/api/workers/register",
  "/api/jobs/claim",
  "/api/maintenance/",
  "/api/backends/wake-kaggle",
];

// Simple HMAC session cookie. We don't want a full JWT dep — a short
// signed timestamp is enough for a single-user password gate.
async function _signSession(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${payload}.${b64}`;
}

async function _verifySession(cookie: string, secret: string): Promise<boolean> {
  const idx = cookie.lastIndexOf(".");
  if (idx <= 0) return false;
  const payload = cookie.slice(0, idx);
  const expected = await _signSession(payload, secret);
  if (expected !== cookie) return false;
  // Payload format: `v1:<expiryEpochMs>`. Reject expired.
  const parts = payload.split(":");
  if (parts.length !== 2 || parts[0] !== "v1") return false;
  const expiry = Number(parts[1]);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Request-ID propagation (unchanged).
  const existing = req.headers.get("x-request-id");
  const reqId =
    existing && existing.length >= 6 ? existing : _genId();
  const resHeaders = new Headers(req.headers);
  resHeaders.set("x-request-id", reqId);

  // Password gate — only if DASHBOARD_PASSWORD is set. Empty = open.
  const password = process.env.DASHBOARD_PASSWORD || "";
  if (password) {
    // Public paths bypass entirely.
    const isPublic =
      PUBLIC_PATHS.has(pathname) ||
      pathname.startsWith("/_next/") ||
      pathname.startsWith("/favicon");
    const isApiKeyRoute = API_KEY_ROUTES.some((p) => pathname.startsWith(p));
    if (!isPublic && !isApiKeyRoute) {
      const cookie = req.cookies.get("dash_auth")?.value;
      const ok = cookie ? await _verifySession(cookie, password) : false;
      if (!ok) {
        // API routes get 401 JSON; pages redirect to /login.
        if (pathname.startsWith("/api/")) {
          return NextResponse.json({ error: "unauthorised" }, { status: 401 });
        }
        const url = req.nextUrl.clone();
        url.pathname = "/login";
        url.searchParams.set("next", pathname);
        return NextResponse.redirect(url);
      }
    }
  }

  const res = NextResponse.next({ request: { headers: resHeaders } });
  res.headers.set("x-request-id", reqId);
  return res;
}

// Cover pages + API. _next static assets skip via the check above so
// bundle chunks aren't gated (page render would blow up otherwise).
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

function _genId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// Export the sign function so /api/auth/login can reuse it.
export { _signSession };
