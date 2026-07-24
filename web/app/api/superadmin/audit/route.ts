import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/superadmin/audit — read the audit_log tail.
 *
 * Query params:
 *   ?actor=<userId>          filter by actor
 *   ?action=<action>         filter by exact action ("user.approve" etc.)
 *   ?limit=<n>               default 100, max 500
 *
 * Returns newest-first. Superadmin only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const actor  = sp.get("actor")  || "";
  const action = sp.get("action") || "";
  const limit  = Math.min(500, Math.max(1, Number(sp.get("limit") || 100)));

  try {
    let q = adminDb().collection("audit_log").orderBy("ts", "desc").limit(limit);
    if (actor)  q = q.where("actor_user_id", "==", actor);
    if (action) q = q.where("action", "==", action);
    const snap = await q.get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      out.push({ id: doc.id, ...d });
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
