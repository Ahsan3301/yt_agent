import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { customAlphabet } from "nanoid";
import { listStorageVideos } from "@/lib/storage-list";
import { requireTenant, assertOwnership } from "@/lib/tenant";

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
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const body = await req.json().catch(() => ({}));
    const provider_id = String(body?.provider_id || "").trim();
    const move = !!body?.move;
    if (!provider_id) {
      return NextResponse.json({ error: "provider_id required" }, { status: 400 });
    }
    // Verify the provider exists + enabled + owned by this caller.
    const p = await adminDb().collection("storage_providers").doc(provider_id).get();
    if (!p.exists) {
      return NextResponse.json({ error: `provider ${provider_id} not found` }, { status: 404 });
    }
    const pd = p.data() as { enabled?: boolean };
    const pOwn = assertOwnership(pd as Record<string, unknown>, auth.tenant);
    if (pOwn) return pOwn;
    if (pd.enabled === false) {
      return NextResponse.json({ error: `provider ${provider_id} is disabled` }, { status: 400 });
    }
    // Verify the run belongs to this caller.
    const runSnap = await adminDb().collection("runs_index").doc(id).get();
    let hasVideo = runSnap.exists;
    let source = "runs_index:doc";
    if (hasVideo) {
      const rOwn = assertOwnership(runSnap.data() as Record<string, unknown>, auth.tenant);
      if (rOwn) return rOwn;
    }
    if (!hasVideo) {
      const hits = await adminDb().collection("runs_index")
        .where("run_id", "==", id).limit(1).get();
      hasVideo = !hits.empty;
      if (hasVideo) {
        source = "runs_index:field";
        const rOwn = assertOwnership(hits.docs[0].data() as Record<string, unknown>, auth.tenant);
        if (rOwn) return rOwn;
      }
    }
    if (!hasVideo) {
      try {
        const inStorage = (await listStorageVideos()).some((v) => v.run_id === id);
        if (inStorage) {
          hasVideo = true;
          source = "storage_only";
        }
      } catch { /* best-effort */ }
    }
    if (!hasVideo) {
      return NextResponse.json(
        { error: `run ${id} not found in Library (no runs_index row + no storage object)` },
        { status: 404 },
      );
    }

    const jobId = _shortId();
    const now = Date.now() / 1000;
    const target_worker = String(body?.target_worker || "").slice(0, 128);
    const run_at = Number(body?.run_at || 0);
    await adminDb().collection("jobs").doc(jobId).set({
      id:            jobId,
      kind:          "copy_storage",
      status:        "queued",
      user_id:       auth.tenant.userId,
      owner_user_id: auth.tenant.userId,
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
      video_source:  source,
      updated_at:    FieldValue.serverTimestamp(),
    });
    logRoute(reqId, "copy_storage queued", { run_id: id, job_id: jobId, provider_id, move });
    return NextResponse.json({ ok: true, job_id: jobId });
  } catch (e) {
    logRoute(reqId, "copy_storage queue failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
