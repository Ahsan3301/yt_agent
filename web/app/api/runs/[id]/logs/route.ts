import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/runs/[id]/logs?since=<epoch_seconds>
 *
 * Return the log lines for a run, ordered by sequence / timestamp.
 *
 * This replaces the LogsPanel's Firestore-JS-SDK subscription on
 * Coolify deploys — the browser doesn't have a Pocketbase realtime
 * connection (that would require exposing PB creds), so instead it
 * polls this endpoint at 1–2s intervals with the last-seen ts.
 *
 * Returns:
 *   {
 *     lines: [{ seq, ts, level, name, msg }],
 *     latest_ts: <max ts seen or the input `since`>
 *   }
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const reqId = newRequestId();
  const { id } = await ctx.params;
  const sinceRaw = req.nextUrl.searchParams.get("since") || "0";
  const since = Number(sinceRaw) || 0;
  const sinceSeqRaw = req.nextUrl.searchParams.get("since_seq") || "0";
  const sinceSeq = Number(sinceSeqRaw) || 0;
  const limit = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || "500")));

  try {
    let q = adminDb().collection("run_logs").where("run_id", "==", id);
    if (since > 0) q = q.where("ts", ">", since);
    const snap = await q.limit(limit).get();
    logRoute(reqId, "run logs", { run_id: id, since, since_seq: sinceSeq, returned: snap.docs.length });
    const lines = snap.docs
      .map((d) => {
        const v = d.data() as Record<string, unknown>;
        return {
          seq:   Number(v.seq ?? 0) || 0,
          ts:    (toEpochMs(v.ts) ?? 0) / 1000,
          level: String(v.level || "INFO"),
          name:  String(v.name || ""),
          msg:   String(v.msg || ""),
        };
      })
      // Drop anything the client already has by seq. PB's `ts` filter is
      // datetime-typed and truncates at millisecond resolution, so lines
      // that share the same millisecond survive the `ts > since` filter
      // and get re-served on every poll. Seq is monotonic + unique per
      // worker, so this cleanly de-dupes.
      .filter((e) => e.seq > sinceSeq)
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq);

    const latest_ts = lines.length ? lines[lines.length - 1].ts : since;
    return NextResponse.json({ lines, latest_ts });
  } catch (e) {
    return NextResponse.json({ error: String(e), lines: [], latest_ts: since }, { status: 500 });
  }
}
