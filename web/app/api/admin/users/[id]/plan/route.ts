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
  let body: { plan_id?: string; months?: number; expires_at?: number; note?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }
  const plan_id = String(body.plan_id || "").trim().toLowerCase();
  if (!plan_id) return NextResponse.json({ error: "plan_id required" }, { status: 400 });

  // Manual billing: payments happen outside the product, so the
  // operator records how long this plan was paid for. `months` is the
  // convenience path ("they paid for 3 months"); `expires_at` allows
  // an exact date. Neither given = no expiry, which is right for free
  // and comped accounts but would be a revenue leak on a paid tier —
  // hence the warning returned below.
  const now = Math.floor(Date.now() / 1000);
  let plan_expires_at = 0;
  if (Number.isFinite(Number(body.expires_at)) && Number(body.expires_at) > 0) {
    plan_expires_at = Math.floor(Number(body.expires_at));
  } else if (Number.isFinite(Number(body.months)) && Number(body.months) > 0) {
    plan_expires_at = now + Math.floor(Number(body.months)) * 30 * 86400;
  }
  const note = String(body.note || "").slice(0, 300);

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
    await ref.set({
      plan_id,
      plan_expires_at,
      plan_note: note,
      plan_assigned_at: now,
      plan_assigned_by: auth.tenant.userId,
    }, { merge: true });
    bustQuotaCache(id);
    await audit(auth.tenant, {
      action: "user.plan_change", target_type: "app_users", target_id: id,
      meta: {
        previous_plan: prev, new_plan: plan_id,
        expires_at: plan_expires_at || null, note: note || null,
      },
    }, req);

    // Surfaced rather than silent: a paid plan with no end date never
    // lapses, and with no payment provider nothing else will catch it.
    const isPaidTier = plan_id !== "free" && plan_id !== "founder";
    return NextResponse.json({
      ok: true, id, plan_id,
      expires_at: plan_expires_at || null,
      warning: (isPaidTier && !plan_expires_at)
        ? "No expiry set — this paid plan will never lapse on its own."
        : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
