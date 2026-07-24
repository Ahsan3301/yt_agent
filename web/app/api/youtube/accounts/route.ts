import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";
import { requireTenant, tenantWhereClauses, assertOwnership } from "@/lib/tenant";

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
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    let q = adminDb().collection("youtube_accounts").limit(100);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
    const snap = await q.get();
    const out: Array<Record<string, unknown>> = [];
    snap.forEach((doc) => {
      const d = (doc.data() || {}) as Record<string, unknown>;
      out.push({
        id: doc.id,
        youtube_channel_id: (d.youtube_channel_id as string) || doc.id,
        title:     (d.title as string) || "",
        thumbnail: (d.thumbnail as string) || "",
        updated_at: toEpochMs(d.updated_at),
      });
    });
    out.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** DELETE /api/youtube/accounts?id=<youtube_channel_id> */
export async function DELETE(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    // Cross-tenant guard — can't unbind someone else's account.
    const acct = await adminDb().collection("youtube_accounts").doc(id).get();
    if (!acct.exists) return NextResponse.json({ ok: true, id, note: "already gone" });
    const ownErr = assertOwnership(acct.data() as Record<string, unknown>, auth.tenant);
    if (ownErr) return ownErr;
    // Only unbind channels owned by THIS user; a superadmin unbinding
    // an account still only touches the account's own owner's channels
    // (a shared YT account is a Phase 5+ concept).
    let boundQ = adminDb().collection("channels").where("youtube_account_id", "==", id);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) boundQ = boundQ.where(f, op, v);
    const bound = await boundQ.get();
    const batch = adminDb().batch();
    bound.forEach((doc) => batch.update(doc.ref, { youtube_account_id: null }));
    batch.delete(adminDb().collection("youtube_accounts").doc(id));
    await batch.commit();
    return NextResponse.json({ ok: true, id, unbound_channels: bound.size });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
