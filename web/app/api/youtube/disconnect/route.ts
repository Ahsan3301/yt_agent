import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/youtube/disconnect — drop the stored refresh token. */
export async function POST(_req: NextRequest) {
  try {
    await adminDb().collection("api_keys").doc("YOUTUBE_REFRESH_TOKEN").delete();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
