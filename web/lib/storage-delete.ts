/**
 * Server-side helper to delete video objects directly from the primary
 * storage bucket (MinIO / R2). Used by /api/maintenance/cleanup* routes
 * so the dashboard doesn't need a live GPU worker to prune videos.
 *
 * Uses the same env-var pattern the rest of the storage layer follows
 * (S3_ENDPOINT_INTERNAL / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 * with MinIO fallbacks). Best-effort deletes — individual failures are
 * caught and returned in the summary instead of aborting the batch.
 */
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

let _client: S3Client | null = null;
let _bucket: string | null = null;

function _s3(): { client: S3Client; bucket: string } {
  if (!_client) {
    _client = new S3Client({
      endpoint:
        process.env.S3_ENDPOINT_INTERNAL ||
        process.env.S3_ENDPOINT ||
        "http://minio:9000",
      region: process.env.S3_REGION || "us-east-1",
      credentials: {
        accessKeyId:     process.env.S3_ACCESS_KEY_ID     || process.env.MINIO_ROOT_USER     || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || "",
      },
      forcePathStyle: true,
    });
    _bucket = process.env.S3_BUCKET || "yt-agent-videos";
  }
  return { client: _client, bucket: _bucket! };
}

/** Delete every run-video keyed by run_id (`videos/<run_id>.mp4`).
 *
 * HEADs each key first, for two reasons that both bit us:
 *
 *   1. S3 and MinIO answer DeleteObject on a MISSING key with 204, not
 *      an error. Deleting blind therefore reports success no matter
 *      what — which is exactly how retention could run for weeks
 *      "deleting" videos while the bucket kept growing (the caller was
 *      passing PB doc ids, which are a hash of run_id, so no key ever
 *      matched and every delete "succeeded").
 *   2. freed space was a flat 15 MB per video guess. Real renders here
 *      are 100-800 MB, so the summary under-reported by ~30x. HEAD
 *      returns the true size for free on the same round trip.
 *
 * `deletedIds` lets the caller mark exactly the rows whose bytes are
 * genuinely gone, instead of assuming the batch worked.
 */
export async function deleteVideosByRunIds(runIds: string[]): Promise<{
  deleted: number;
  failed: number;
  missing: number;
  deletedIds: string[];
  freed_bytes: number;
  freed_mb_estimate: number;
  errors: string[];
}> {
  const out = {
    deleted: 0, failed: 0, missing: 0,
    deletedIds: [] as string[],
    freed_bytes: 0, freed_mb_estimate: 0,
    errors: [] as string[],
  };
  if (runIds.length === 0) return out;

  const { client, bucket } = _s3();
  for (const runId of runIds) {
    const key = `videos/${runId}.mp4`;
    let size = 0;
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      size = Number(head.ContentLength || 0);
    } catch {
      // Not there. Counted separately from a delete so the summary
      // cannot claim space it never reclaimed.
      out.missing += 1;
      continue;
    }
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      out.deleted += 1;
      out.deletedIds.push(runId);
      out.freed_bytes += size;
    } catch (e) {
      out.failed += 1;
      const msg = String(e).slice(0, 120);
      if (out.errors.length < 5) out.errors.push(`${runId}: ${msg}`);
    }
  }
  out.freed_mb_estimate = Math.round(out.freed_bytes / 1e6);
  return out;
}
