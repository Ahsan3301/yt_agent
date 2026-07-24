import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { toEpochMs } from "@/lib/timestamps";
import { listStorageVideos } from "@/lib/storage-list";
import { requireTenant, tenantWhereClauses } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/runs — list runs from runs_index, augmented with any
 *  videos found in the primary storage provider that don't have a DB
 *  row yet.
 *
 *  Cross-source sync rationale: the DB write can fail (worker OOM,
 *  PB down, unique-index collision after a retry). When that happens
 *  the video is safely in MinIO but invisible to the Library page.
 *  Listing the bucket and synthesising a stub row for every orphan
 *  object means the user always sees every video they've rendered —
 *  the DB is treated as authoritative when present, and storage is
 *  the fallback. Runs from a specific tier (Kaggle GPU / Oracle side
 *  worker / Colab) all land under the same `videos/<run_id>.mp4`
 *  key convention so this stays tier-agnostic. */
export async function GET(req: NextRequest) {
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    let q = adminDb().collection("runs_index").orderBy("finished_at", "desc").limit(200);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
    const [snap, storage] = await Promise.all([
      q.get(),
      // Storage-only synthesis stays global — it only surfaces bucket
      // orphans without user metadata. When tenancy tightens further
      // in Phase 2b, buckets will be per-user; for now this is fine.
      listStorageVideos().catch(() => []),
    ]);
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const finishedMs = toEpochMs(d.finished_at);
      const startedMs  = toEpochMs(d.started_at);
      // Drop completely empty placeholder rows (junk from earlier
      // broken writes; guarded going forward but a few may already
      // exist in prod).
      const hasContent = (
        d.channel || d.title || d.video_url || d.public_url ||
        d.status || finishedMs || startedMs || d.run_id
      );
      if (!hasContent) return;
      const runId = String(d.run_id || doc.id);
      seen.add(runId);
      out.push({
        ...d,
        run_id:      runId,
        finished_at: finishedMs ? finishedMs / 1000 : null,
        started_at:  startedMs ? startedMs / 1000 : null,
      });
    });
    // Storage-only synthesis: for every video in the bucket that we
    // don't already have a DB row for, emit a stub row so it renders
    // in the Library.
    let orphansAdded = 0;
    for (const v of storage) {
      if (seen.has(v.run_id)) continue;
      seen.add(v.run_id);
      orphansAdded++;
      out.push({
        run_id:         v.run_id,
        video_url:      v.public_url,
        public_url:     v.public_url,
        status:         "storage_only",
        finished_at:    v.last_modified || null,
        started_at:     null,
        video_bytes:    v.size,
        video_storage:  "primary",
        // Flag so the UI can style these differently — no channel /
        // title / duration until the user re-imports metadata.
        storage_only:   true,
      });
    }
    // Re-sort combined list by finished_at desc so the merged view
    // stays chronological.
    out.sort((a, b) => {
      const af = Number(a.finished_at) || 0;
      const bf = Number(b.finished_at) || 0;
      return bf - af;
    });
    logRoute(reqId, "list runs", { count: out.length, orphans: orphansAdded });
    return NextResponse.json(out);
  } catch (e) {
    logRoute(reqId, "list runs failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
