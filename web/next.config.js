/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
    return [
      // Proxy /api/* to the FastAPI backend in dev.
      { source: "/api/:path*", destination: "http://localhost:8000/api/:path*" },
    ];
  },
};

module.exports = nextConfig;
