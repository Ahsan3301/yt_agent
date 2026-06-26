import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/jobs/<id> — status of one job.
 *
 * Reads from Firestore (always current per the worker's _persist
 * mirror). For "running" jobs the doc has the latest percent/step
 * from the worker. For "complete"/"failed"/"cancelled" the doc is
 * terminal and self-sufficient.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reqId = newRequestId();
  try {
    const snap = await adminDb().collection("jobs").doc(id).get();
    if (!snap.exists) {
      logRoute(reqId, "job not found", { job_id: id });
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    const data = snap.data();
    logRoute(reqId, "job get", { job_id: id, status: data?.status });
    return NextResponse.json({ ...data, id: data?.id || id });
  } catch (e) {
    logRoute(reqId, "job get failed", { job_id: id, err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * DELETE /api/jobs/<id> — cancel a running job.
 *
 * Reads the job's backend_url from Firestore and forwards the cancel
 * request to that worker. Terminal jobs are no-ops (return ok).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reqId = newRequestId();
  try {
    const snap = await adminDb().collection("jobs").doc(id).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    const data = snap.data() as Record<string, unknown> | undefined;
    const status = String(data?.status || "");
    if (["complete", "failed", "cancelled"].includes(status)) {
      logRoute(reqId, "cancel noop (terminal)", { job_id: id, status });
      return NextResponse.json({ ok: true, noop: true });
    }
    const backendUrl = (data?.backend_url as string) || "";
    if (!backendUrl) {
      // Job is still in the queue waiting for a worker. Drop it
      // directly from Firestore.
      await adminDb().collection("jobs").doc(id).delete();
      logRoute(reqId, "cancel: dropped queued", { job_id: id });
      return NextResponse.json({ ok: true });
    }
    try {
      const r = await fetch(`${backendUrl.replace(/\/$/, "")}/api/jobs/${id}`, {
        method: "DELETE",
        headers: { "X-Request-Id": reqId, "X-Vercel-Gateway": "1" },
      });
      logRoute(reqId, "cancel forwarded", { job_id: id, status: r.status });
      return NextResponse.json({ ok: r.ok });
    } catch (e) {
      logRoute(reqId, "cancel forward failed", { job_id: id, err: String(e) });
      return NextResponse.json({ error: "worker unreachable" }, { status: 502 });
    }
  } catch (e) {
    logRoute(reqId, "DELETE jobs failed", { job_id: id, err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
