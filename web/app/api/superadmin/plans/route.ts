import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Plans CRUD — superadmin only.
 *
 * Schema in migration 0012 (plans collection):
 *   slug (UNIQUE), name, price_monthly, price_yearly, max_channels,
 *   max_renders_month, shared_worker_access, features (JSON), active,
 *   sort_order.
 *
 * quota.ts treats max_* = 0 or null as unlimited. Deleting a plan
 * that users are assigned to is refused — the admin must reassign
 * those users first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const snap = await adminDb().collection("plans").limit(50).get();
    const out: unknown[] = [];
    snap.forEach((doc) => out.push({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
    out.sort((a, b) => Number((a as { sort_order?: number }).sort_order || 0)
                     - Number((b as { sort_order?: number }).sort_order || 0));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * POST /api/superadmin/plans — create a new plan.
 * Body: { slug, name, price_monthly, price_yearly, max_channels,
 *         max_renders_month, shared_worker_access, features?, active?, sort_order? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const slug = String(body.slug || "").trim().toLowerCase();
  if (!slug || !/^[a-z0-9_-]{2,30}$/.test(slug)) {
    return NextResponse.json({ error: "slug must be 2-30 chars [a-z0-9_-]" }, { status: 400 });
  }
  // Reject duplicates early with a friendlier error than the unique-index violation.
  const existing = await adminDb().collection("plans").where("slug", "==", slug).limit(1).get();
  if (!existing.empty) {
    return NextResponse.json({ error: `plan slug '${slug}' already exists` }, { status: 409 });
  }

  const payload = _sanitize(body, slug);
  try {
    // Use slug as the doc id so /api/superadmin/plans/{slug} route works.
    // slug isn't 15-char alphanumeric so _pbId will hash it — that's fine,
    // downstream code always looks up by the slug field via .where().
    await adminDb().collection("plans").doc(slug).set(payload);
    await audit(auth.tenant, {
      action: "plan.create", target_type: "plans", target_id: slug,
      meta: { name: payload.name, active: payload.active },
    }, req);
    return NextResponse.json({ ok: true, ...payload });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export function _sanitizePlan(body: Record<string, unknown>, slug: string): Record<string, unknown> {
  return _sanitize(body, slug);
}

function _sanitize(body: Record<string, unknown>, slug: string): Record<string, unknown> {
  const num = (v: unknown, def: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : def;
  };
  const bool = (v: unknown): boolean => v === true || v === "true";
  return {
    slug,
    name:                 String(body.name || "").slice(0, 80),
    price_monthly:        num(body.price_monthly, 0),          // in cents
    price_yearly:         num(body.price_yearly, 0),
    max_channels:         num(body.max_channels, 0),           // 0 = unlimited
    max_renders_month:    num(body.max_renders_month, 0),
    shared_worker_access: bool(body.shared_worker_access),
    features:             _cleanFeatures(body.features),
    active:               bool(body.active),
    sort_order:           num(body.sort_order, 100),
  };
}

function _cleanFeatures(v: unknown): string {
  // Stored as JSON string per PB schema (json field, but we canonicalise).
  if (!v) return "{}";
  if (typeof v === "string") {
    try { JSON.parse(v); return v.slice(0, 20000); } catch { return "{}"; }
  }
  try { return JSON.stringify(v).slice(0, 20000); } catch { return "{}"; }
}
