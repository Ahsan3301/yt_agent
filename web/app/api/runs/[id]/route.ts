import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { pickWorkers, newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/runs/<id> — full run summary from Firestore. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reqId = newRequestId();
  try {
    const snap = await adminDb().collection("run_summaries").doc(id).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }
    const d = snap.data() || {};
    const data = (d as { data?: unknown }).data;
    if (!data) return NextResponse.json({ error: "empty summary" }, { status: 404 });
    logRoute(reqId, "run get", { run_id: id });
    return NextResponse.json({
      ...(data as Record<string, unknown>),
      run_id: id,
    });
  } catch (e) {
    logRoute(reqId, "run get failed", { run_id: id, err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * DELETE /api/runs/<id> — drop the run from Firestore + best-effort
 * delete the video file via any live worker (R2 / SFTP cleanup).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reqId = newRequestId();
  try {
    // Firestore cleanup first — authoritative.
    await adminDb().collection("runs_index").doc(id).delete();
    await adminDb().collection("run_summaries").doc(id).delete();

    // Best-effort: any worker can clean the video bytes.
    const workers = await pickWorkers();
    if (workers[0]) {
      fetch(`${workers[0].url.replace(/\/$/, "")}/api/runs/${id}`, {
        method: "DELETE",
        headers: { "X-Request-Id": reqId, "X-Vercel-Gateway": "1" },
      }).catch(() => {});
    }
    logRoute(reqId, "run deleted", { run_id: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logRoute(reqId, "run delete failed", { run_id: id, err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
