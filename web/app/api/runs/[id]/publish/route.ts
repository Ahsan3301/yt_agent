import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { customAlphabet } from "nanoid";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const _shortId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 15);

/**
 * POST /api/runs/[id]/publish
 * Body: { youtube_account_id: string, title?: string, description?: string, tags?: string[] }
 *
 * Queues a side-job (kind='publish_youtube') for the worker to pick
 * up. The worker downloads the run's video, calls uploader.py with
 * the specified account, and writes youtube_video_id back to
 * runs_index on success.
 *
 * Returns the created job id so the client can poll /api/jobs/[id].
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const reqId = newRequestId();
  try {
    const body = await req.json().catch(() => ({}));
    const youtube_account_id = String(body?.youtube_account_id || "").trim();
    if (!youtube_account_id) {
      return NextResponse.json({ error: "youtube_account_id required" }, { status: 400 });
    }
    // Verify the account exists.
    const yt = await adminDb().collection("youtube_accounts").doc(youtube_account_id).get();
    if (!yt.exists) {
      return NextResponse.json({ error: `youtube account ${youtube_account_id} not found` }, { status: 404 });
    }
    // Verify the run has a video.
    const runSnap = await adminDb().collection("runs_index").doc(id).get();
    // If not found by direct id, try by run_id field.
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
    // Target worker: "" (auto) | "gpu" | "dashboard" | "<instance_id>"
    const target_worker = String(body?.target_worker || "").slice(0, 128);
    // Scheduled execution: absolute epoch seconds. 0 or absent = run ASAP.
    const run_at = Number(body?.run_at || 0);
    await adminDb().collection("jobs").doc(jobId).set({
      id:            jobId,
      kind:          "publish_youtube",
      status:        "queued",
      run_id:        id,
      youtube_account_id,
      title:         String(body?.title || ""),
      description:   String(body?.description || ""),
      tags:          Array.isArray(body?.tags) ? body.tags.map(String).slice(0, 30) : [],
      channel:       "publish",
      dry_run:       false,
      queued_at:     now,
      created_by:    "dashboard",
      req_id:        reqId,
      current_step:  "publish_youtube",
      current_step_label: run_at > now ? `Scheduled for ${new Date(run_at * 1000).toISOString()}` : "Queued for publish",
      percent:       0,
      target_worker,
      run_at:        run_at > 0 ? run_at : 0,
      updated_at:    FieldValue.serverTimestamp(),
    });
    logRoute(reqId, "publish queued", { run_id: id, job_id: jobId, youtube_account_id });
    return NextResponse.json({ ok: true, job_id: jobId });
  } catch (e) {
    logRoute(reqId, "publish queue failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
