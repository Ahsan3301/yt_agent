/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Coolify deployment uses Next.js standalone output — produces a
  // self-contained server.js + minimal node_modules under
  // .next/standalone, ~150 MB Docker image instead of ~800 MB. Vercel
  // ignores this setting (its build infra makes its own choices), so
  // toggling it here is safe for both deployments.
  output: "standalone",

  // firebase-admin uses native deps that need real Node resolution.
  serverExternalPackages: ["firebase-admin"],

  // Allow dev-server access from Tailscale + LAN hostnames. Next 16 blocks
  // non-localhost dev origins by default (HMR + asset fetches). Add anything
  // you connect from here.
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "*.ts.net",          // Tailscale magic DNS
    "*.local",           // mDNS
    "169.254.*",         // link-local (Tailscale showed this on this machine)
    "192.168.*",
    "10.*",
  ],

  async rewrites() {
    // Dev only: proxy /api/* to the local FastAPI backend on :8000 so
    // `npm run dev` works without a manual fetch URL.
    //
    // CRITICAL: this MUST be skipped in production. On Vercel the proxy
    // would try to reach localhost (a private address), and Vercel's edge
    // rejects that with DNS_HOSTNAME_RESOLVED_PRIVATE. In production the
    // frontend talks to the backend directly via the URL it resolves from
    // the Hostinger registry (see lib/api.ts → resolveBackend).
    if (process.env.NODE_ENV !== "development") return [];
    return [
      { source: "/api/:path*", destination: "http://localhost:8000/api/:path*" },
    ];
  },

  // Phase 3 (2026-07-24): all app pages moved from top-level (/channels,
  // /queue, ...) into the (app) route group under /app/*. Redirect old
  // bookmarks + in-flight browser tabs to their new homes. 308 = permanent
  // preserves method (GET stays GET) — fine for pages that were only ever
  // fetched via GET. Landing at `/` is now a public marketing page (see
  // web/app/(marketing)/page.tsx).
  async redirects() {
    return [
      { source: "/channels", destination: "/app/channels", permanent: true },
      { source: "/channels/:path*", destination: "/app/channels/:path*", permanent: true },
      { source: "/queue", destination: "/app/queue", permanent: true },
      { source: "/queue/:path*", destination: "/app/queue/:path*", permanent: true },
      { source: "/history", destination: "/app/history", permanent: true },
      { source: "/history/:path*", destination: "/app/history/:path*", permanent: true },
      { source: "/reports", destination: "/app/reports", permanent: true },
      { source: "/keys", destination: "/app/keys", permanent: true },
      { source: "/settings", destination: "/app/settings", permanent: true },
      { source: "/storage", destination: "/app/storage", permanent: true },
      { source: "/create", destination: "/app/create", permanent: true },
      { source: "/create/:path*", destination: "/app/create/:path*", permanent: true },
      // Monitor + health moved to /admin/*; only admins+ can access.
      // Non-admin users hitting the old URL bounce to /admin (which
      // itself bounces to /app for non-admins) — same net effect.
      { source: "/monitor", destination: "/admin/monitor", permanent: true },
      { source: "/health", destination: "/admin/health", permanent: true },
    ];
  },
};

module.exports = nextConfig;
