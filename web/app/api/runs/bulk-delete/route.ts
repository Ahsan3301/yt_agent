import { NextRequest, NextResponse } from "next/server";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { deleteOneRun } from "@/app/api/runs/[id]/route";

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
  try {
    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.run_ids)
      ? body.run_ids.map((s: unknown) => String(s || "")).filter(Boolean).slice(0, 100)
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "run_ids required" }, { status: 400 });
    }
    logRoute(reqId, "bulk delete start", { count: ids.length });
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
