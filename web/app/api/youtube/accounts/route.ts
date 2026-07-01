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
    // Sort by PB system field 'updated' — always present + indexed.
    // The wrapper's orderBy() maps 'updated_at' → 'updated', but pass
    // the correct name explicitly so this route works even if some
    // caller reaches an older wrapper.
    const snap = await adminDb()
      .collection("youtube_accounts")
      .orderBy("updated", "desc")
      .limit(50)
      .get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = (doc.data() || {}) as Record<string, unknown>;
      out.push({
        id: doc.id,
        youtube_channel_id: (d.youtube_channel_id as string) || doc.id,
        title:     (d.title as string) || "",
        thumbnail: (d.thumbnail as string) || "",
        updated_at: _toEpochMs(d.updated_at),
      });
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** Normalize any timestamp shape to epoch ms.
 *  Handles: Firestore Timestamp (.toMillis), epoch number (sec or ms),
 *  ISO string, or null. */
function _toEpochMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v > 10_000_000_000 ? v : v * 1000;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return isNaN(parsed) ? null : parsed;
  }
  if (typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
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
