import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { bustQuotaCache } from "@/lib/quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/users/[id]/plan
 * Body: { plan_id: "free" | "pro" | "founder" | ... }
 *
 * Admin+ only. Reassigns the user's plan_id. Verifies the plan exists.
 * Busts the user's quota cache so the new caps apply immediately.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "admin" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  let body: { plan_id?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }
  const plan_id = String(body.plan_id || "").trim().toLowerCase();
  if (!plan_id) return NextResponse.json({ error: "plan_id required" }, { status: 400 });

  // Only superadmins can assign the founder plan (which is unlimited).
  if (plan_id === "founder" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "only superadmin can assign the founder plan" }, { status: 403 });
  }

  try {
    // Verify plan exists.
    const planQ = await adminDb().collection("plans").where("slug", "==", plan_id).limit(1).get();
    if (planQ.empty) return NextResponse.json({ error: `plan '${plan_id}' not found` }, { status: 404 });

    const ref = adminDb().collection("app_users").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return NextResponse.json({ error: "user not found" }, { status: 404 });
    const prev = String((doc.data() as { plan_id?: string }).plan_id || "");
    await ref.set({ plan_id }, { merge: true });
    bustQuotaCache(id);
    await audit(auth.tenant, {
      action: "user.plan_change", target_type: "app_users", target_id: id,
      meta: { previous_plan: prev, new_plan: plan_id },
    }, req);
    return NextResponse.json({ ok: true, id, plan_id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
