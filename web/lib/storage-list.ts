/**
 * Lightweight object listing against the primary S3-compatible storage.
 *
 * Used by /api/runs to surface videos that exist in storage but not in
 * the runs_index collection — e.g. after a write_run() failure or a
 * copy_storage side-job that landed the bytes but never got a DB row.
 * Without this fallback the Library page silently drops those videos
 * and the user has no way to see or recover them.
 *
 * Reads config from env vars (S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID
 * / S3_SECRET_ACCESS_KEY / S3_PUBLIC_BASE), same shape the Python
 * worker uses. Falls back to a per-provider PB lookup would be nicer
 * but adds another PB round-trip on every history-page load; the env
 * path is the fast path.
 */
import { S3Client, ListObjectsV2Command, type ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";

export type StorageVideo = {
  key: string;         // e.g. "videos/20260701_073045.mp4"
  run_id: string;      // extracted from key, e.g. "20260701_073045"
  size: number;
  last_modified: number; // epoch seconds
  public_url: string;
};

let _client: S3Client | null = null;
function client(): S3Client | null {
  if (_client) return _client;
  const endpoint = process.env.S3_ENDPOINT;
  const key      = process.env.S3_ACCESS_KEY_ID;
  const secret   = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !key || !secret) return null;
  _client = new S3Client({
    endpoint,
    region: process.env.S3_REGION || "auto",
    credentials: { accessKeyId: key, secretAccessKey: secret },
    // MinIO needs path-style; R2 and modern AWS S3 don't care.
    forcePathStyle: true,
  });
  return _client;
}

/** List all `videos/*.mp4` objects in the primary bucket.
 *  Returns [] on any error — this is a best-effort augmentation, not
 *  a source of truth, so we swallow failures and let runs_index be the
 *  primary answer. */
export async function listStorageVideos(): Promise<StorageVideo[]> {
  const c = client();
  const bucket = process.env.S3_BUCKET;
  const publicBase = (process.env.S3_PUBLIC_BASE || "").replace(/\/$/, "");
  if (!c || !bucket) return [];
  const out: StorageVideo[] = [];
  let continuationToken: string | undefined = undefined;
  try {
    do {
      const resp: ListObjectsV2CommandOutput = await c.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "videos/",
        ContinuationToken: continuationToken,
        MaxKeys: 500,
      }));
      for (const obj of resp.Contents || []) {
        const key = obj.Key || "";
        if (!key.toLowerCase().endsWith(".mp4")) continue;
        const base = key.replace(/^videos\//, "").replace(/\.mp4$/i, "");
        // Strip any /-suffixed subpath: `videos/foo/final.mp4` → `foo`.
        const run_id = base.split("/")[0];
        if (!run_id) continue;
        out.push({
          key,
          run_id,
          size: Number(obj.Size || 0),
          last_modified: obj.LastModified ? Math.floor(obj.LastModified.getTime() / 1000) : 0,
          public_url: publicBase ? `${publicBase}/${key}` : "",
        });
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (e) {
    // Best-effort; log and return whatever we already have.
    console.warn("listStorageVideos failed:", e);
  }
  return out;
}
