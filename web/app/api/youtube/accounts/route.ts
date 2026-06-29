import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Multi-account YouTube credential management.
 *
 *   GET    /api/youtube/accounts          → list connected YouTube
 *                                            accounts (id, title,
 *                                            thumbnail, connected_at)
 *   DELETE /api/youtube/accounts?id=<id>  → revoke + remove an account
 *
 * Credentials JSON is NEVER returned by GET — only metadata. The
 * worker reads creds directly from Firestore.
 */
export async function GET() {
  try {
    const snap = await adminDb()
      .collection("youtube_accounts")
      .orderBy("updated_at", "desc")
      .limit(50)
      .get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      out.push({
        id: doc.id,
        youtube_channel_id: d.youtube_channel_id || doc.id,
        title: d.title || "",
        thumbnail: d.thumbnail || "",
        updated_at: d.updated_at?.toMillis?.() || null,
      });
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** DELETE /api/youtube/accounts?id=<youtube_channel_id> */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    // Also unbind any dashboard-channels that were pointing at this
    // YouTube account — leaving a dangling youtube_account_id would
    // cause future renders to 404 at the uploader.
    const ref = adminDb().collection("channels");
    const bound = await ref.where("youtube_account_id", "==", id).get();
    const batch = adminDb().batch();
    bound.forEach((doc) => batch.update(doc.ref, { youtube_account_id: null }));
    batch.delete(adminDb().collection("youtube_accounts").doc(id));
    await batch.commit();
    return NextResponse.json({ ok: true, id, unbound_channels: bound.size });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
