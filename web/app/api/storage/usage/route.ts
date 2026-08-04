import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { listStorageVideos, storageConfigured } from "@/lib/storage-list";
import { getConfig } from "@/lib/platform-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/storage/usage
 *
 * What is actually in the video bucket, and what the nightly sweep is
 * about to do with it.
 *
 * Exists because "will storage fill up?" was previously only answerable
 * over SSH with `docker exec` and an S3 listing — and the answer was
 * worse than expected: retention had been deleting nothing at all for
 * weeks while reporting success, because it built object keys from the
 * PocketBase doc id (a hash) instead of the run_id.
 *
 * The important distinction here is `deletable_published` vs
 * `deletable_unpublished`. Deleting a published video is reversible in
 * the sense that matters — the Library keeps the row and plays it from
 * YouTube. Deleting an unpublished one destroys the only copy. The
 * numbers are separated so that is a decision rather than a surprise.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "admin" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!storageConfigured()) {
    return NextResponse.json({
      configured: false,
      note: "No S3/MinIO credentials, so the bucket cannot be inspected.",
    });
  }

  const retentionDays = Number(await getConfig("RETENTION_VIDEOS_DAYS", "")) || 30;
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - retentionDays * 86400;

  try {
    const videos = await listStorageVideos();

    // run_id -> youtube id, so "can this be deleted safely" is answered
    // from the record rather than guessed.
    const published = new Map<string, string>();
    try {
      const snap = await adminDb().collection("runs_index").limit(2000).get();
      snap.forEach((d) => {
        const r = (d.data() || {}) as Record<string, unknown>;
        const rid = String(r.run_id || d.id);
        const yt = String(r.youtube_video_id || "");
        if (rid) published.set(rid, yt);
      });
    } catch { /* fall through — everything reads as unpublished */ }

    let totalBytes = 0;
    let oldest = 0;
    const deletable = { published: 0, unpublished: 0, bytes: 0 };
    const orphaned = { count: 0, bytes: 0 };

    for (const v of videos) {
      totalBytes += v.size;
      if (v.last_modified > 0 && (oldest === 0 || v.last_modified < oldest)) {
        oldest = v.last_modified;
      }
      const known = published.has(v.run_id);
      if (!known) {
        // In the bucket with no Library row at all. cleanup-stale
        // removes these after its own (7 day) window.
        orphaned.count += 1;
        orphaned.bytes += v.size;
      }
      // `known` matters: the retention sweep walks runs_index rows and
      // deletes the storage object for each one. A file with no
      // runs_index row is invisible to it and can never be removed by
      // retention no matter how old it gets — only the orphan track
      // (cleanup-stale) can take those.
      //
      // Counting orphans here made the panel promise work the sweep
      // cannot do: it advertised "next sweep removes 36 videos
      // (11291 MB)" while every one of those 36 was an orphan, so
      // cleanup ran and correctly reported "nothing was past
      // retention". The number and the outcome disagreed because they
      // were computed from different sources — this panel from bucket
      // mtimes, the sweep from runs_index.
      if (known && v.last_modified > 0 && v.last_modified < cutoff) {
        deletable.bytes += v.size;
        if (published.get(v.run_id)) deletable.published += 1;
        else deletable.unpublished += 1;
      }
    }

    return NextResponse.json({
      configured: true,
      retention_days: retentionDays,
      videos: {
        count: videos.length,
        bytes: totalBytes,
        mb: Math.round(totalBytes / 1e6),
        oldest_epoch: oldest,
        oldest_age_days: oldest ? Math.floor((nowSec - oldest) / 86400) : null,
      },
      // What tonight's sweep would remove at the current setting.
      next_sweep: {
        published: deletable.published,
        unpublished: deletable.unpublished,
        mb: Math.round(deletable.bytes / 1e6),
      },
      // Bytes with no Library row — handled by cleanup-stale, not by
      // the retention window.
      orphaned: {
        count: orphaned.count,
        mb: Math.round(orphaned.bytes / 1e6),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
