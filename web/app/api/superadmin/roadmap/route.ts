import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Roadmap CRUD — superadmin only.
 *
 *   GET  /api/superadmin/roadmap                → list all items
 *   POST /api/superadmin/roadmap                → bulk upsert
 *
 * The public /(marketing)/roadmap page reads from PB via server-side
 * admin token — the ADMIN_ONLY listRule doesn't gate it.
 */

const STATUS_ENUM = new Set(["live", "next", "planned", "changelog"]);

type Item = {
  id?: string;
  status: string;
  title: string;
  body: string;
  tag?: string;
  section?: string;
  sort_order?: number;
};

function _clean(v: unknown): Item[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 200).map((x) => {
    const o = (x || {}) as Record<string, unknown>;
    const status = String(o.status || "").toLowerCase();
    return {
      id:         o.id ? String(o.id).slice(0, 32) : undefined,
      status:     STATUS_ENUM.has(status) ? status : "planned",
      title:      String(o.title || "").slice(0, 160),
      body:       String(o.body  || "").slice(0, 600),
      tag:        o.tag     ? String(o.tag).slice(0, 40)     : undefined,
      section:    o.section ? String(o.section).slice(0, 40) : undefined,
      sort_order: Number.isFinite(Number(o.sort_order)) ? Number(o.sort_order) : 0,
    };
  }).filter((it) => it.title);
}

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const snap = await adminDb().collection("roadmap_items").orderBy("sort_order", "asc").get();
    const items = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { items?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const items = _clean(body.items);

  try {
    const coll = adminDb().collection("roadmap_items");
    // Snapshot current for the delete diff
    const before = await coll.get();
    const beforeIds = new Set<string>(before.docs.map((d) => d.id));
    const keepIds = new Set<string>();
    const now = Math.floor(Date.now() / 1000);

    for (const it of items) {
      const payload = {
        status:     it.status,
        title:      it.title,
        body:       it.body,
        tag:        it.tag     ?? null,
        section:    it.section ?? null,
        sort_order: it.sort_order ?? 0,
        updated:    now,
      };
      if (it.id && beforeIds.has(it.id)) {
        keepIds.add(it.id);
        await coll.doc(it.id).set(payload, { merge: true });
      } else {
        const ref = await coll.add({ ...payload, created: now });
        keepIds.add(ref.id);
      }
    }
    // Anything present before but missing from the submission → delete
    for (const oldId of beforeIds) {
      if (!keepIds.has(oldId)) await coll.doc(oldId).delete();
    }

    await audit(auth.tenant, {
      action: "roadmap.save",
      target_type: "roadmap_items",
      target_id: "*",
      meta: { count: items.length },
    }, req);

    return NextResponse.json({ ok: true, count: items.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keep = FieldValue;
