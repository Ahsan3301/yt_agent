import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/launch-info — static config for the LaunchBanner.
 * Exposes the Colab notebook URL and HF Space URL (server-side env
 * vars) without leaking other secrets.
 */
export async function GET() {
  return NextResponse.json({
    colab_url: process.env.NEXT_PUBLIC_COLAB_URL || "",
    hf_space_url: process.env.NEXT_PUBLIC_HF_SPACE_URL || "",
  });
}
