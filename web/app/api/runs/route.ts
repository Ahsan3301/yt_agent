import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { toEpochMs } from "@/lib/timestamps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/runs — list runs from the runs_index collection. Skips
 *  empty placeholder rows (no finished_at AND no started_at AND no
 *  channel — likely orphan rows from a failed migration). */
export async function GET() {
  const reqId = newRequestId();
  try {
    const snap = await adminDb()
      .collection("runs_index")
      .orderBy("finished_at", "desc")
      .limit(200)
      .get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const finishedMs = toEpochMs(d.finished_at);
      const startedMs  = toEpochMs(d.started_at);
      // Drop completely empty rows so the Library page isn't peppered
      // with blank entries from earlier broken writes.
      const hasContent = (
        d.channel || d.title || d.video_url || d.public_url ||
        d.status || finishedMs || startedMs || d.run_id
      );
      if (!hasContent) return;
      out.push({
        ...d,
        run_id:      d.run_id || doc.id,
        finished_at: finishedMs ? finishedMs / 1000 : null,
        started_at:  startedMs ? startedMs / 1000 : null,
      });
    });
    logRoute(reqId, "list runs", { count: out.length });
    return NextResponse.json(out);
  } catch (e) {
    logRoute(reqId, "list runs failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
