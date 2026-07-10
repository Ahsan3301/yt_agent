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
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

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
 * Returns { deleted, failed, freed_mb_estimate }. */
export async function deleteVideosByRunIds(runIds: string[]): Promise<{
  deleted: number;
  failed: number;
  freed_mb_estimate: number;
  errors: string[];
}> {
  const out = { deleted: 0, failed: 0, freed_mb_estimate: 0, errors: [] as string[] };
  if (runIds.length === 0) return out;

  const { client, bucket } = _s3();
  for (const runId of runIds) {
    const key = `videos/${runId}.mp4`;
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      out.deleted += 1;
      // Shorts land around ~15 MB. Real size isn't returned by DELETE
      // so this is an estimate for the summary.
      out.freed_mb_estimate += 15;
    } catch (e) {
      out.failed += 1;
      const msg = String(e).slice(0, 120);
      if (out.errors.length < 5) out.errors.push(`${runId}: ${msg}`);
    }
  }
  return out;
}
