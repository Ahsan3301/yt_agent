import { NextRequest } from "next/server";

/**
 * Resolve the dashboard's PUBLIC origin (scheme + host) — the URL the
 * browser sees, used to construct OAuth callback URLs.
 *
 * Resolution order:
 *   1. `PUBLIC_BASE_URL` env var — explicit override. Set this on
 *      Coolify deployments where the dashboard sits behind a reverse
 *      proxy (Caddy / Traefik). The container's own bind address
 *      (http://0.0.0.0:3000) is NOT publicly reachable, so we can't
 *      let routes use req.nextUrl.origin.
 *   2. `NEXT_PUBLIC_DOMAIN` — fallback, no scheme assumed → https://.
 *   3. `DOMAIN` — same idea, mirrors the compose env var.
 *   4. `X-Forwarded-Host` / `X-Forwarded-Proto` headers — set by most
 *      reverse proxies. Trustworthy when origin is behind a known proxy.
 *   5. `req.nextUrl.origin` — final fallback (Vercel, local dev — works
 *      because there's no proxy layer in the way).
 *
 * Always returns a string with NO trailing slash.
 */
export function publicOrigin(req: NextRequest): string {
  const explicit = (process.env.PUBLIC_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const domain =
    (process.env.NEXT_PUBLIC_DOMAIN || process.env.DOMAIN || "").trim();
  if (domain) {
    const withScheme = domain.startsWith("http") ? domain : `https://${domain}`;
    return withScheme.replace(/\/$/, "");
  }

  // Trust proxy-set headers when present.
  const xfHost = req.headers.get("x-forwarded-host");
  const xfProto = req.headers.get("x-forwarded-proto") || "https";
  if (xfHost) return `${xfProto}://${xfHost}`.replace(/\/$/, "");

  return req.nextUrl.origin.replace(/\/$/, "");
}
