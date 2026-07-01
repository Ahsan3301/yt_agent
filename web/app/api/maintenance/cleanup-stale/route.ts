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
    orphan_videos: {
      deleted:      dryRun ? 0 : orphans.length,
      bytes_freed:  orphans.reduce((n, o) => n + o.size, 0),
      keys:         orphans.map((o) => o.key),
    },
  });
}
