import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/launch-info — static config for the LaunchBanner.
 * Exposes the Colab notebook URL and HF Space URL (server-side env
 * vars) without leaking other secrets.
 *
 * Cached at the Vercel edge for 1 hour (env vars change rarely);
 * stale-while-revalidate gives free instant responses for 24h after
 * a deploy. ~zero Vercel function invocations from this route.
 */
export async function GET() {
  return NextResponse.json({
    colab_url: process.env.NEXT_PUBLIC_COLAB_URL || "",
    hf_space_url: process.env.NEXT_PUBLIC_HF_SPACE_URL || "",
  }, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
