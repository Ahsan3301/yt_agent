import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { _bustJobsCache } from "@/app/api/jobs/route";
import { requireTenant, tenantWhereClauses } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/jobs/bulk
 *
 * Body: { action: "cancel" | "delete", ids?: string[], filter?: "queued"|"running"|"failed"|"complete"|"cancelled" }
 *
 *   cancel: set status=cancelled + finished_at. The worker's
 *           heartbeat/run loop checks this and stops. For jobs not yet
 *           claimed, this just prevents them from ever being claimed.
 *   delete: drop the Firestore doc. Use after cancel for housekeeping.
 *
 * One of `ids` or `filter` must be present. Filter applies to status.
 */
type BulkBody = {
  action?: "cancel" | "delete";
  ids?: string[];
  filter?: "queued" | "running" | "failed" | "complete" | "cancelled";
};

export async function POST(req: NextRequest) {
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const { tenant } = auth;
  try {
    const body = (await req.json().catch(() => ({}))) as BulkBody;
    const action = body.action;
    if (action !== "cancel" && action !== "delete") {
      return NextResponse.json(
        { error: "action must be 'cancel' or 'delete'" },
        { status: 400 },
      );
    }

    // Resolve the target set — always tenant-filtered.
    let targetIds: string[] = [];
    if (body.ids && body.ids.length > 0) {
      // Filter caller-supplied ids to only those they own. Under
      // tenant enforcement we do the ownership check per-id.
      if (tenant.enforce) {
        for (const id of body.ids) {
          try {
            const d = await adminDb().collection("jobs").doc(id).get();
            if (!d.exists) continue;
            if (String((d.data() as { user_id?: string }).user_id || "") === tenant.userId) {
              targetIds.push(id);
            }
          } catch { /* skip */ }
        }
      } else {
        targetIds = body.ids;
      }
    } else if (body.filter) {
      let q = adminDb().collection("jobs")
        .where("status", "==", body.filter).limit(200);
      for (const [f, op, v] of tenantWhereClauses(tenant)) q = q.where(f, op, v);
      const snap = await q.get();
      targetIds = snap.docs.map((d) => d.id);
    }

    if (!targetIds.length) {
      return NextResponse.json({ ok: true, affected: 0, note: "no jobs matched" });
    }

    const now = Date.now() / 1000;
    const batch = adminDb().batch();
    for (const id of targetIds) {
      const ref = adminDb().collection("jobs").doc(id);
      if (action === "cancel") {
        batch.update(ref, {
          status: "cancelled",
          finished_at: now,
          error: "cancelled via dashboard bulk action",
        });
      } else {
        batch.delete(ref);
      }
    }
    await batch.commit();
    _bustJobsCache();
    logRoute(reqId, `bulk ${action}`, { count: targetIds.length, filter: body.filter });
    return NextResponse.json({ ok: true, action, affected: targetIds.length });
  } catch (e) {
    logRoute(reqId, "bulk failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
