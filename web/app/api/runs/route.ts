import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function _toEpoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "_seconds" in v) {
    const t = v as { _seconds: number };
    return t._seconds;
  }
  if (typeof v === "object" && v !== null && "seconds" in v) {
    const t = v as { seconds: number };
    return t.seconds;
  }
  return null;
}

/** GET /api/runs — list runs from Firestore runs_index. */
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
      const d = doc.data();
      out.push({
        ...d,
        run_id: d.run_id || doc.id,
        finished_at: _toEpoch(d.finished_at),
      });
    });
    logRoute(reqId, "list runs", { count: out.length });
    return NextResponse.json(out);
  } catch (e) {
    logRoute(reqId, "list runs failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
