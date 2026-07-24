import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/users/[id]/approve
 *
 * Admin+ only. Flips app_users.<id>.status from "pending" -> "active",
 * assigns plans/free by default (superadmin can reassign later via the
 * plan route). Idempotent — approving an already-active user is a no-op.
 * Logs to audit_log.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    if (!doc.exists) return NextResponse.json({ error: "user not found" }, { status: 404 });
    const d = doc.data() as Record<string, unknown>;
    if (d.status === "active") {
      return NextResponse.json({ ok: true, note: "already active" });
    }
    const now = Math.floor(Date.now() / 1000);
    await ref.set({
      status: "active",
      plan_id: d.plan_id || "free",
      approved_by: auth.tenant.userId,
      approved_at: now,
    }, { merge: true });
    await audit(auth.tenant, {
      action: "user.approve",
      target_type: "app_users",
      target_id: id,
      meta: { email: d.email, previous_status: d.status || "pending" },
    }, req);
    return NextResponse.json({ ok: true, id, status: "active" });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
