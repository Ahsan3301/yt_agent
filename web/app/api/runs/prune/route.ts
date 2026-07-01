import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { deleteOneRun } from "@/app/api/runs/[id]/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/runs/prune
 * Body: { older_than_days: number, dry_run?: boolean }
 *
 * Delete every run older than `older_than_days`. Returns the list of
 * run_ids that would be deleted (dry_run=true) or that WERE deleted.
 *
 * This is the user-triggered variant of the daily maintenance/cleanup
 * cron — bound to a button on the Library page. Same PB row + storage
 * cleanup path as bulk-delete.
 */
export async function POST(req: NextRequest) {
  const reqId = newRequestId();
  try {
    const body = await req.json().catch(() => ({}));
    const days = Number(body?.older_than_days || 0);
    const dryRun = !!body?.dry_run;
    if (!Number.isFinite(days) || days < 1) {
      return NextResponse.json(
        { error: "older_than_days must be a positive integer" },
        { status: 400 },
      );
    }
    const cutoff = (Date.now() - days * 86_400_000) / 1000;

    // Enumerate runs by finished_at older than cutoff.
    const snap = await adminDb().collection("runs_index").limit(500).get();
    const target: string[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as { run_id?: string; finished_at?: unknown };
      const finishedSec = (toEpochMs(d.finished_at) || 0) / 1000;
      if (finishedSec > 0 && finishedSec < cutoff) {
        const rid = String(d.run_id || doc.id);
        if (rid) target.push(rid);
      }
    });

    if (dryRun) {
      logRoute(reqId, "prune dry-run", { days, count: target.length });
      return NextResponse.json({
        ok: true, dry_run: true, older_than_days: days,
        would_delete: target.length, run_ids: target,
      });
    }

    // Execute deletions with a small concurrency cap.
    const CONC = 5;
    const results: Record<string, unknown> = {};
    for (let i = 0; i < target.length; i += CONC) {
      const batch = target.slice(i, i + CONC);
      const batchResults = await Promise.all(
        batch.map(async (id) => [id, await deleteOneRun(id, reqId)] as const),
      );
      for (const [id, r] of batchResults) results[id] = r;
    }
    const successCount = Object.values(results).filter((r) => {
      const rr = r as Record<string, boolean>;
      return rr.runs_index && rr.run_summaries;
    }).length;
    logRoute(reqId, "prune done", {
      days, requested: target.length, fully_deleted: successCount,
    });
    return NextResponse.json({
      ok: true, older_than_days: days,
      requested: target.length, fully_deleted: successCount,
      results,
    });
  } catch (e) {
    logRoute(reqId, "prune failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
