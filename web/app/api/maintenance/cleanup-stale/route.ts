import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";
import { listStorageVideos } from "@/lib/storage-list";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/maintenance/cleanup-stale
 *
 *  Two-part sweep to keep the DB + storage from accumulating junk:
 *
 *  1. **Stale backends rows**: any doc whose last_seen_at is older than
 *     the freshness cutoff (default 10 min) is deleted. Container
 *     restarts pre-stable-INSTANCE_ID left dupes in prod; a Kaggle
 *     kernel that got killed mid-heartbeat also leaves a dangling row.
 *     Frontend already filters these from display, but they still cost
 *     PB list-record RTTs on every Monitor page load.
 *
 *  2. **Orphan videos in the primary bucket**: any object under
 *     videos/*.mp4 whose run_id (basename without extension) has no
 *     matching runs_index row AND is older than the retention window
 *     (default 7 days) is deleted from MinIO. Prevents renders that
 *     landed bytes but failed the DB write from silently hoarding
 *     bucket space forever.
 *
 *  Auth: same X-API-Key gate as the other /api/maintenance/* routes,
 *  set via RENDER_TRIGGER_KEY. Callable from the Coolify cron-sidecar
 *  or manually from the dashboard's Health page.
 *
 *  Query params (all optional):
 *    ?stale_seconds=600         backend row freshness cutoff (default 10 min)
 *    ?orphan_retention=604800   orphan video retention (default 7 days)
 *    ?dry_run=1                 report what would be deleted, delete nothing
 */
export async function POST(req: NextRequest) {
  const url  = new URL(req.url);
  const apiKey = req.headers.get("x-api-key") || "";
  if (!process.env.RENDER_TRIGGER_KEY || apiKey !== process.env.RENDER_TRIGGER_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const staleSeconds    = Number(url.searchParams.get("stale_seconds") || 600);
  const orphanRetention = Number(url.searchParams.get("orphan_retention") || 604800);
  const dryRun          = url.searchParams.get("dry_run") === "1";
  const nowSec = Date.now() / 1000;

  // ── 1. Stale backends rows ───────────────────────────────
  const staleBackends: { id: string; last_seen_at?: number; instance_id?: string }[] = [];
  try {
    const snap = await adminDb().collection("backends").get();
    snap.forEach((doc) => {
      const d = doc.data() as { last_seen_at?: unknown; instance_id?: string };
      const lastMs = toEpochMs(d.last_seen_at) || 0;
      const lastSec = lastMs / 1000;
      if (lastSec === 0 || lastSec < nowSec - staleSeconds) {
        staleBackends.push({ id: doc.id, last_seen_at: lastSec, instance_id: d.instance_id });
      }
    });
    if (!dryRun) {
      for (const row of staleBackends) {
        try {
          await adminDb().collection("backends").doc(row.id).delete();
        } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    return NextResponse.json({ error: `backends sweep failed: ${e}` }, { status: 500 });
  }

  // ── 1b. Rescue orphaned running/claimed jobs ─────────────
  // When a Kaggle kernel dies mid-run (session cap, OOM, crash), the
  // job it was working on stays status='running' forever. The worker
  // is now gone from backends. Move any such job back to 'queued' so
  // the next available worker picks it up. If the same job orphans
  // twice → mark failed so we don't loop forever.
  const orphanedJobs: { id: string; run_id: string | null; prev_status: string; action: "requeued" | "failed" }[] = [];
  try {
    const staleInstanceIds = new Set<string>(
      staleBackends.map((b) => b.instance_id || "").filter(Boolean),
    );
    // Also include instance ids that DON'T appear in backends at all —
    // the row might have been swept already in a previous tick, but a
    // job doc could still reference it.
    const liveInstanceIds = new Set<string>();
    try {
      const liveSnap = await adminDb().collection("backends").get();
      liveSnap.forEach((doc) => {
        const d = doc.data() as { instance_id?: string; last_seen_at?: unknown };
        const lastMs = toEpochMs(d.last_seen_at) || 0;
        if (lastMs / 1000 >= nowSec - staleSeconds && d.instance_id) {
          liveInstanceIds.add(String(d.instance_id));
        }
      });
    } catch { /* best-effort */ }

    const jobsSnap = await adminDb().collection("jobs").get();
    for (const doc of jobsSnap.docs) {
      const j = doc.data() as {
        status?: string; backend_instance_id?: string;
        started_at?: unknown; run_id?: string; orphan_count?: number;
      };
      const st = String(j.status || "");
      if (st !== "running" && st !== "claimed") continue;
      const instId = String(j.backend_instance_id || "");
      // Skip if the worker is still alive.
      if (instId && liveInstanceIds.has(instId)) continue;
      // Also skip when the job just started (< staleSeconds ago) —
      // the worker may still be registering. Uses started_at OR the
      // doc's updated field as a proxy.
      const startedMs = toEpochMs(j.started_at) || 0;
      if (startedMs && startedMs / 1000 > nowSec - staleSeconds) continue;

      const prevOrphanCount = Number(j.orphan_count || 0);
      const action: "requeued" | "failed" = prevOrphanCount >= 1 ? "failed" : "requeued";
      const patch: Record<string, unknown> = action === "requeued"
        ? {
            status: "queued",
            backend_instance_id: "",
            backend_url: "",
            started_at: null,
            claimed_at: null,
            percent: 0,
            current_step: null,
            current_step_label: null,
            orphan_count: prevOrphanCount + 1,
            error: `worker ${instId || "?"} disappeared mid-run; requeued for retry`,
          }
        : {
            status: "failed",
            finished_at: nowSec,
            error: `worker ${instId || "?"} disappeared twice; giving up`,
            current_step: "done",
            current_step_label: "Failed",
          };
      if (!dryRun) {
        try {
          await adminDb().collection("jobs").doc(doc.id).update(patch);
        } catch { /* best-effort */ }
      }
      orphanedJobs.push({
        id: doc.id, run_id: j.run_id || null, prev_status: st, action,
      });
    }
  } catch (e) {
    return NextResponse.json({ error: `orphan-job sweep failed: ${e}` }, { status: 500 });
  }

  // ── 2. Orphan videos ─────────────────────────────────────
  const orphans: { key: string; run_id: string; size: number; last_modified: number }[] = [];
  try {
    const [runsSnap, storage] = await Promise.all([
      adminDb().collection("runs_index").get(),
      listStorageVideos().catch(() => []),
    ]);
    const knownRunIds = new Set<string>();
    runsSnap.forEach((doc) => {
      const d = doc.data() as { run_id?: string };
      if (d.run_id) knownRunIds.add(String(d.run_id));
      knownRunIds.add(doc.id);
    });
    for (const v of storage) {
      if (knownRunIds.has(v.run_id)) continue;
      if (v.last_modified === 0) continue;
      if (v.last_modified > nowSec - orphanRetention) continue;   // still inside retention window
      orphans.push({ key: v.key, run_id: v.run_id, size: v.size, last_modified: v.last_modified });
    }
    if (!dryRun && orphans.length > 0) {
      const s3 = new S3Client({
        endpoint:
          process.env.S3_ENDPOINT_INTERNAL ||
          process.env.S3_ENDPOINT ||
          "http://minio:9000",
        region: process.env.S3_REGION || "us-east-1",
        credentials: {
          accessKeyId:     process.env.S3_ACCESS_KEY_ID    || process.env.MINIO_ROOT_USER    || "",
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || "",
        },
        forcePathStyle: true,
      });
      const bucket = process.env.S3_BUCKET || "yt-agent-videos";
      for (const o of orphans) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.key }));
        } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    return NextResponse.json({ error: `orphans sweep failed: ${e}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    dry_run:      dryRun,
    stale_backends: {
      deleted: dryRun ? 0 : staleBackends.length,
      rows:    staleBackends,
    },
    orphan_jobs: {
      handled: dryRun ? 0 : orphanedJobs.length,
      rows:    orphanedJobs,
    },
    orphan_videos: {
      deleted:      dryRun ? 0 : orphans.length,
      bytes_freed:  orphans.reduce((n, o) => n + o.size, 0),
      keys:         orphans.map((o) => o.key),
    },
  });
}
