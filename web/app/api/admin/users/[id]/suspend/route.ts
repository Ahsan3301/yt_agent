import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/users/[id]/suspend
 *
 * Admin+ only. Sets status="suspended". Login route rejects suspended
 * users at auth time. Their data + channels are untouched — this is
 * reversible (POST /approve puts them back to "active"). Cannot
 * suspend the superadmin. Cannot suspend yourself.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "admin" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  if (id === auth.tenant.userId) {
    return NextResponse.json({ error: "cannot suspend yourself" }, { status: 400 });
  }
  try {
    const ref = adminDb().collection("app_users").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return NextResponse.json({ error: "user not found" }, { status: 404 });
    const d = doc.data() as Record<string, unknown>;
    if (d.role === "superadmin") {
      return NextResponse.json({ error: "cannot suspend a superadmin" }, { status: 400 });
    }
    await ref.set({ status: "suspended" }, { merge: true });
    await audit(auth.tenant, {
      action: "user.suspend",
      target_type: "app_users",
      target_id: id,
      meta: { email: d.email, previous_status: d.status || "" },
    }, req);
    return NextResponse.json({ ok: true, id, status: "suspended" });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
