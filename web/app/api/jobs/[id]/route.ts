import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireTenant, assertOwnership } from "@/lib/tenant";

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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const snap = await adminDb().collection("jobs").doc(id).get();
    if (!snap.exists) {
      logRoute(reqId, "job not found", { job_id: id });
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    const data = snap.data();
    const ownErr = assertOwnership(data as Record<string, unknown>, auth.tenant);
    if (ownErr) return ownErr;
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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const snap = await adminDb().collection("jobs").doc(id).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    const data = snap.data() as Record<string, unknown> | undefined;
    const ownErr = assertOwnership(data, auth.tenant);
    if (ownErr) return ownErr;
    const status = String(data?.status || "");
    if (["complete", "failed", "cancelled"].includes(status)) {
      logRoute(reqId, "cancel noop (terminal)", { job_id: id, status });
      return NextResponse.json({ ok: true, noop: true });
    }
    const backendUrl = (data?.backend_url as string) || "";
    // Outbound-poll workers (Oracle side-worker, and any future
    // reverse-tunnel worker) don't register a backend_url — they poll
    // PB for their own job status every 2s. Hard-deleting the PB row
    // orphans them: their bridge sees the doc vanish, treats it as
    // "not cancelled", and the pipeline runs to completion (== ghost
    // render). Set status=cancelled instead when the job is already
    // claimed; only hard-delete truly-queued rows.
    if (!backendUrl) {
      if (status === "queued") {
        await adminDb().collection("jobs").doc(id).delete();
        logRoute(reqId, "cancel: dropped queued", { job_id: id });
        return NextResponse.json({ ok: true });
      }
      // claimed/running with no backend_url → outbound-poll worker.
      // Flip status so the worker's PB-status bridge notices within
      // its 2s poll cycle and calls run_state.request_cancel().
      await adminDb().collection("jobs").doc(id).update({
        status: "cancelled",
        error: "cancelled by user",
        finished_at: Date.now() / 1000,
      });
      logRoute(reqId, "cancel: signalled outbound-poll worker via PB", { job_id: id, status });
      return NextResponse.json({ ok: true, mode: "pb-signal" });
    }
    try {
      const r = await fetch(`${backendUrl.replace(/\/$/, "")}/api/jobs/${id}`, {
        method: "DELETE",
        headers: { "X-Request-Id": reqId, "X-Vercel-Gateway": "1" },
      });
      logRoute(reqId, "cancel forwarded", { job_id: id, status: r.status });
      // Also flip PB status as a belt-and-suspenders — the worker's
      // /api/jobs/<id> DELETE handler may not have PB-write access,
      // and even push-based workers should have their PB doc reflect
      // "cancelled" for the dashboard UI + cleanup safety guard.
      try {
        await adminDb().collection("jobs").doc(id).update({
          status: "cancelled",
          error: "cancelled by user",
          finished_at: Date.now() / 1000,
        });
      } catch { /* best-effort */ }
      return NextResponse.json({ ok: r.ok });
    } catch (e) {
      logRoute(reqId, "cancel forward failed", { job_id: id, err: String(e) });
      // Worker unreachable — still flip PB so a returning worker
      // (or the operator watching the dashboard) sees the cancel.
      try {
        await adminDb().collection("jobs").doc(id).update({
          status: "cancelled",
          error: "cancelled by user (worker unreachable)",
          finished_at: Date.now() / 1000,
        });
      } catch { /* best-effort */ }
      return NextResponse.json({ error: "worker unreachable, PB flipped to cancelled" }, { status: 502 });
    }
  } catch (e) {
    logRoute(reqId, "DELETE jobs failed", { job_id: id, err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
