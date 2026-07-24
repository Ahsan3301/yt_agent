import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DELETE /api/admin/users/[id]/reject
 *
 * Admin+ only. Hard-deletes a PENDING user row. Refuses to delete
 * active/suspended users (use /suspend instead) or superadmins.
 * Logs to audit_log.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "admin" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const ref = adminDb().collection("app_users").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return NextResponse.json({ ok: true, note: "already gone" });
    const d = doc.data() as Record<string, unknown>;
    if (d.role === "superadmin") {
      return NextResponse.json({ error: "cannot reject a superadmin" }, { status: 400 });
    }
    if (d.status !== "pending") {
      return NextResponse.json(
        { error: "only pending users can be rejected; suspend an active user instead" },
        { status: 400 },
      );
    }
    await ref.delete();
    await audit(auth.tenant, {
      action: "user.reject",
      target_type: "app_users",
      target_id: id,
      meta: { email: d.email },
    }, req);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
