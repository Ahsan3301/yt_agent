import { NextRequest, NextResponse } from "next/server";
import { pickWorkers, newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant, tenantWhereClauses } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/queue — system-wide summary for the dashboard.
 * Reports live worker counts, queued+running job counts, and the
 * best worker URL (so the LaunchBanner can decide what to show).
 */
export async function GET(req: NextRequest) {
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const workers = await pickWorkers();
    const online = workers.length;
    const busy = workers.filter((w) => w.status === "busy").length;

    // Count jobs in non-terminal state — scoped to caller under enforce.
    let queued = 0;
    let running = 0;
    // PB adapter's .where("status", "in", [...]) may not support the
    // "in" operator on every backend; run two parallel queries + merge.
    const [qSnap, rSnap] = await Promise.all([
      (() => {
        let q = adminDb().collection("jobs").where("status", "==", "queued");
        for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
        return q.limit(500).get();
      })(),
      (() => {
        let q = adminDb().collection("jobs").where("status", "==", "running");
        for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
        return q.limit(500).get();
      })(),
    ]);
    queued = qSnap.size;
    running = rSnap.size;
    // Preserve the original snap variable for the log line below.
    const snap = { forEach: (_fn: (d: unknown) => void) => {} };
    // (counting done above via two parallel scoped queries; keep the
    // per-doc forEach as a no-op for shape compat with existing loggers)
    snap.forEach(() => {});

    logRoute(reqId, "queue summary", { online, busy, queued, running });
    return NextResponse.json({
      online,
      busy,
      available: online - busy,
      queued,
      running,
      workers: workers.map((w) => ({
        instance_id: w.instance_id,
        url: w.url,
        tier: w.tier,
        status: w.status,
        queue_depth: w.queue_depth,
        label: w.label,
      })),
    });
  } catch (e) {
    logRoute(reqId, "queue failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
