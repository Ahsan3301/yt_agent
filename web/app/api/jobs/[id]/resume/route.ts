import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { _bustJobsCache } from "@/app/api/jobs/route";
import { requireTenant, assertOwnership, stampUserId } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/jobs/[id]/resume
 *
 *  Retry a failed publish_youtube or copy_storage job by creating a
 *  fresh `queued` job with the same payload. We don't mutate the
 *  original — it stays visible with status=failed so the user has an
 *  audit trail of what happened + what the new job replaces.
 *
 *  Only works for side-jobs (kind in {publish_youtube, copy_storage}).
 *  Retrying a full render is a different UX (the user goes to Library
 *  and re-triggers via the channel), so we reject render kinds here to
 *  avoid accidentally kicking off a 90-second render they didn't want.
 *
 *  The new job:
 *  - inherits run_id, kind, target_worker, youtube_account_id,
 *    provider_id, move, title, description, tags, backend params
 *  - clears status/started_at/finished_at/error and gets a fresh id
 *  - has resumed_from set so the UI can show a "retry of X" hint
 */
const RESUMABLE_KINDS = new Set(["publish_youtube", "copy_storage"]);

// Fields we DON'T copy — they're per-attempt state, not settings.
const NON_INHERITED = new Set([
  "id", "status", "error", "started_at", "finished_at",
  "queued_at", "claimed_at", "updated_at", "created", "updated",
  "backend_instance_id", "backend_url",
  "resumed_from", "video_id", "public_url", "youtube_url",
]);

export async function POST(
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
    const orig = snap.data() as Record<string, unknown>;
    const ownErr = assertOwnership(orig, auth.tenant);
    if (ownErr) return ownErr;
    const kind = String(orig.kind || "render");
    if (!RESUMABLE_KINDS.has(kind)) {
      return NextResponse.json(
        { error: `resume only supported for side-jobs (publish_youtube, copy_storage). This job is kind='${kind}'.` },
        { status: 400 },
      );
    }
    // Failed-only guard: resuming a running/complete/queued job doesn't
    // make sense — either it's already going or the user wants a fresh
    // Publish click from the Library instead.
    const origStatus = String(orig.status || "");
    if (origStatus !== "failed") {
      return NextResponse.json(
        { error: `can only resume failed jobs. This one has status='${origStatus}'.` },
        { status: 400 },
      );
    }

    // Build the new job by inheriting everything except per-attempt state.
    const inherited: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(orig)) {
      if (NON_INHERITED.has(k)) continue;
      inherited[k] = v;
    }

    // Fresh id + fresh timestamps + queued state.
    const newId = _shortId();
    const newJob: Record<string, unknown> = {
      ...inherited,
      id:             newId,
      status:         "queued",
      queued_at:      Date.now() / 1000,
      started_at:     null,
      finished_at:    null,
      error:          null,
      backend_instance_id: null,
      backend_url:    null,
      resumed_from:   id,   // audit link to the failed original
      created_by:     "resume",
      req_id:         reqId,
      updated_at:     FieldValue.serverTimestamp(),
    };

    // Stamp caller's user_id + owner_user_id even when tenant filter
    // isn't yet enforced, so the resumed job is discoverable per-user.
    const stamped = stampUserId({ ...newJob, owner_user_id: auth.tenant.userId }, auth.tenant);
    await adminDb().collection("jobs").doc(newId).set(stamped);
    _bustJobsCache();
    logRoute(reqId, "resume side-job", { original: id, new_id: newId, kind });
    return NextResponse.json({
      ok:            true,
      new_job_id:    newId,
      kind,
      resumed_from:  id,
    });
  } catch (e) {
    logRoute(reqId, "resume failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function _shortId(): string {
  const a = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 12; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}
