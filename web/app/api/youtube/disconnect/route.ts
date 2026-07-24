import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/youtube/disconnect — drop the caller's stored refresh
 *  token (per-user shadow) and, if they were the last user holding the
 *  legacy singleton, clear that too. Never touches other users' tokens. */
export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    // Per-user shadow: remove just the YOUTUBE_REFRESH_TOKEN key from
    // this user's api_keys blob (leave other keys untouched).
    try {
      const shadowRef = adminDb().collection("settings").doc(`${auth.tenant.userId}__api_keys`);
      const cur = await shadowRef.get();
      if (cur.exists) {
        const blob = (cur.data() as { data?: unknown }).data;
        const parsed: Record<string, string> =
          typeof blob === "string" ? JSON.parse(blob) :
          blob && typeof blob === "object" ? (blob as Record<string, string>) : {};
        delete parsed.YOUTUBE_REFRESH_TOKEN;
        await shadowRef.set({
          data: parsed,
          user_id: auth.tenant.userId,
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: false });
      }
    } catch { /* soft */ }
    // Only wipe the legacy singleton if it was pointing at THIS user.
    try {
      const legacy = await adminDb().collection("api_keys").doc("YOUTUBE_REFRESH_TOKEN").get();
      if (legacy.exists) {
        const d = legacy.data() as { user_id?: string };
        if (!d.user_id || d.user_id === auth.tenant.userId) {
          await adminDb().collection("api_keys").doc("YOUTUBE_REFRESH_TOKEN").delete();
        }
      }
    } catch { /* soft */ }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
