import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { customAlphabet } from "nanoid";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const _shortId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 15);

/**
 * POST /api/runs/[id]/copy-storage
 * Body: { provider_id: string, move?: boolean }
 *
 * Queues a side-job (kind='copy_storage') for the worker. The worker
 * downloads the run's current video, uploads to the target storage
 * provider, and writes the mirror URL into runs_index.mirrors. If
 * move=true it also deletes the source after successful copy.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const reqId = newRequestId();
  try {
    const body = await req.json().catch(() => ({}));
    const provider_id = String(body?.provider_id || "").trim();
    const move = !!body?.move;
    if (!provider_id) {
      return NextResponse.json({ error: "provider_id required" }, { status: 400 });
    }
    // Verify the provider exists + enabled.
    const p = await adminDb().collection("storage_providers").doc(provider_id).get();
    if (!p.exists) {
      return NextResponse.json({ error: `provider ${provider_id} not found` }, { status: 404 });
    }
    const pd = p.data() as { enabled?: boolean };
    if (pd.enabled === false) {
      return NextResponse.json({ error: `provider ${provider_id} is disabled` }, { status: 400 });
    }
    // Verify the run has a video.
    const runSnap = await adminDb().collection("runs_index").doc(id).get();
    let hasVideo = runSnap.exists;
    if (!hasVideo) {
      const hits = await adminDb().collection("runs_index")
        .where("run_id", "==", id).limit(1).get();
      hasVideo = !hits.empty;
    }
    if (!hasVideo) {
      return NextResponse.json({ error: `run ${id} not found in Library` }, { status: 404 });
    }

    const jobId = _shortId();
    const now = Date.now() / 1000;
    const target_worker = String(body?.target_worker || "").slice(0, 128);
    const run_at = Number(body?.run_at || 0);
    await adminDb().collection("jobs").doc(jobId).set({
      id:            jobId,
      kind:          "copy_storage",
      status:        "queued",
      run_id:        id,
      provider_id,
      move,
      channel:       "storage",
      dry_run:       false,
      queued_at:     now,
      created_by:    "dashboard",
      req_id:        reqId,
      current_step:  "copy_storage",
      current_step_label: run_at > now
        ? `Scheduled for ${new Date(run_at * 1000).toISOString()}`
        : move ? "Queued for move" : "Queued for copy",
      percent:       0,
      target_worker,
      run_at:        run_at > 0 ? run_at : 0,
      updated_at:    FieldValue.serverTimestamp(),
    });
    logRoute(reqId, "copy_storage queued", { run_id: id, job_id: jobId, provider_id, move });
    return NextResponse.json({ ok: true, job_id: jobId });
  } catch (e) {
    logRoute(reqId, "copy_storage queue failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
