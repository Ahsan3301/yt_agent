import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { deleteOneRun } from "@/app/api/runs/[id]/route";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/runs/bulk-delete
 * Body: { run_ids: string[] }  —  up to 100 per call.
 *
 * Sequentially deletes each run's DB rows + best-effort storage cleanup.
 * Returns a per-id success map so the UI can highlight which ones
 * needed manual attention.
 */
export async function POST(req: NextRequest) {
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const body = await req.json().catch(() => ({}));
    const raw: string[] = Array.isArray(body?.run_ids)
      ? body.run_ids.map((s: unknown) => String(s || "")).filter(Boolean).slice(0, 100)
      : [];
    if (raw.length === 0) {
      return NextResponse.json({ error: "run_ids required" }, { status: 400 });
    }
    // Cross-tenant guard: filter ids to those the caller actually owns.
    // Superadmin sees everything; enforcement scope respects the flag.
    let ids = raw;
    if (auth.tenant.enforce) {
      ids = [];
      for (const id of raw) {
        try {
          // Check summary first; fall back to index by run_id field.
          const s = await adminDb().collection("run_summaries").doc(id).get();
          let owner = "";
          if (s.exists) owner = String((s.data() as { user_id?: string }).user_id || "");
          if (!owner) {
            const q = await adminDb().collection("runs_index")
              .where("run_id", "==", id).limit(1).get();
            if (!q.empty) owner = String((q.docs[0].data() as { user_id?: string }).user_id || "");
          }
          if (owner && owner === auth.tenant.userId) ids.push(id);
        } catch { /* skip on error */ }
      }
    }
    if (ids.length === 0) {
      return NextResponse.json({
        ok: true, requested: raw.length, fully_deleted: 0, results: {},
        note: auth.tenant.enforce ? "no matching owned runs" : "no runs",
      });
    }
    logRoute(reqId, "bulk delete start", { count: ids.length, requested: raw.length });
    const results: Record<string, unknown> = {};
    // Parallel with a concurrency cap so we don't hammer PB with 100
    // simultaneous writes when the caller sends the max.
    const CONC = 6;
    for (let i = 0; i < ids.length; i += CONC) {
      const batch = ids.slice(i, i + CONC);
      const batchResults = await Promise.all(
        batch.map(async (id) => [id, await deleteOneRun(id, reqId)] as const),
      );
      for (const [id, r] of batchResults) results[id] = r;
    }
    const successCount = Object.values(results).filter((r) => {
      const rr = r as Record<string, boolean>;
      return rr.runs_index && rr.run_summaries;
    }).length;
    logRoute(reqId, "bulk delete done", {
      requested: ids.length, fully_deleted: successCount,
    });
    return NextResponse.json({
      ok: true,
      requested: ids.length,
      fully_deleted: successCount,
      results,
    });
  } catch (e) {
    logRoute(reqId, "bulk delete failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
