import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireTenant, assertOwnership } from "@/lib/tenant";

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
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const sinceRaw = req.nextUrl.searchParams.get("since") || "0";
  const since = Number(sinceRaw) || 0;
  const sinceSeqRaw = req.nextUrl.searchParams.get("since_seq") || "0";
  const sinceSeq = Number(sinceSeqRaw) || 0;
  const limit = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || "500")));

  // Cross-tenant guard: verify the run belongs to this caller before
  // streaming logs. Check run_summaries first (id-keyed) then
  // runs_index by run_id field.
  if (auth.tenant.enforce) {
    let ownerOk = false;
    try {
      const summary = await adminDb().collection("run_summaries").doc(id).get();
      if (summary.exists) {
        const d = summary.data() as { user_id?: string };
        ownerOk = String(d.user_id || "") === auth.tenant.userId;
      } else {
        const idx = await adminDb().collection("runs_index")
          .where("run_id", "==", id).limit(1).get();
        if (!idx.empty) {
          const d = idx.docs[0].data() as { user_id?: string };
          ownerOk = String(d.user_id || "") === auth.tenant.userId;
        } else {
          // No index row either — no way to check ownership; deny.
          ownerOk = false;
        }
      }
    } catch { ownerOk = false; }
    if (!ownerOk) return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  void assertOwnership;

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
      // Drop anything the client already has by seq. Only apply this
      // filter when the client passed a real cursor (sinceSeq > 0) AND
      // the row itself has a real seq — historical rows in PB were
      // written with the seq column missing, and we don't want to drop
      // those. Client-side dedup by (ts,msg) covers seqless rows.
      .filter((e) => !(sinceSeq > 0 && e.seq > 0) || e.seq > sinceSeq)
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq);

    const latest_ts = lines.length ? lines[lines.length - 1].ts : since;
    return NextResponse.json({ lines, latest_ts });
  } catch (e) {
    return NextResponse.json({ error: String(e), lines: [], latest_ts: since }, { status: 500 });
  }
}
