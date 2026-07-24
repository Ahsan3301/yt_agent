import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { _sanitizePlan } from "../route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Per-plan CRUD by slug.
 *   PUT    — update
 *   DELETE — refuses to delete if any app_users row references it
 */
async function _findPlan(slug: string) {
  const q = await adminDb().collection("plans").where("slug", "==", slug).limit(1).get();
  if (q.empty) return null;
  return q.docs[0];
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { slug } = await ctx.params;
  const doc = await _findPlan(slug);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id: doc.id, ...(doc.data() as Record<string, unknown>) });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { slug } = await ctx.params;
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const doc = await _findPlan(slug);
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  const payload = _sanitizePlan(body, slug);
  try {
    await adminDb().collection("plans").doc(doc.id).set(payload, { merge: true });
    await audit(auth.tenant, {
      action: "plan.update", target_type: "plans", target_id: slug,
      meta: { previous: doc.data() },
    }, req);
    return NextResponse.json({ ok: true, ...payload });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { slug } = await ctx.params;
  if (slug === "founder") {
    return NextResponse.json({ error: "cannot delete the founder plan" }, { status: 400 });
  }
  const doc = await _findPlan(slug);
  if (!doc) return NextResponse.json({ ok: true, note: "already gone" });
  // Refuse if any user is assigned this plan.
  const users = await adminDb().collection("app_users").where("plan_id", "==", slug).limit(1).get();
  if (!users.empty) {
    return NextResponse.json({
      error: `refuse: users are still assigned this plan. Reassign them first.`,
    }, { status: 409 });
  }
  try {
    await adminDb().collection("plans").doc(doc.id).delete();
    await audit(auth.tenant, {
      action: "plan.delete", target_type: "plans", target_id: slug,
      meta: { snapshot: doc.data() },
    }, req);
    return NextResponse.json({ ok: true, slug });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
