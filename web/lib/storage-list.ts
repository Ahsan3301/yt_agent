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
  // Prefer the internal Docker-network endpoint when both are set —
  // the Coolify compose stack sets S3_ENDPOINT_INTERNAL=http://minio:9000
  // for exactly this kind of server-side call, dodging the public
  // Traefik path (and its TLS overhead) entirely.
  const endpoint =
    process.env.S3_ENDPOINT_INTERNAL ||
    process.env.S3_ENDPOINT ||
    "http://minio:9000";
  const key    = process.env.S3_ACCESS_KEY_ID    || process.env.MINIO_ROOT_USER;
  const secret = process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD;
  if (!key || !secret) return null;
  _client = new S3Client({
    endpoint,
    region: process.env.S3_REGION || "us-east-1",
    credentials: { accessKeyId: key, secretAccessKey: secret },
    // MinIO needs path-style; R2 and modern AWS S3 don't care.
    forcePathStyle: true,
  });
  return _client;
}

/** Public URL prefix for a given bucket key. Reads the same envs the
 *  Python worker does when it writes video_url on a successful upload,
 *  so orphan rows synthesised here point at the same URLs the real
 *  runs_index rows use. */
function publicUrlFor(bucket: string, key: string): string {
  const explicit = (
    process.env.S3_PUBLIC_BASE ||
    process.env.NEXT_PUBLIC_S3_PUBLIC_BASE ||
    ""
  ).replace(/\/$/, "");
  if (explicit) return `${explicit}/${key}`;
  // Derive from PUBLIC_BASE_URL (domain only, no scheme in some deploys).
  const pb = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (pb) {
    const host = pb.startsWith("http") ? pb : `https://${pb}`;
    return `${host}/${bucket}/${key}`;
  }
  return "";
}

// In-memory cache. /api/runs is polled every 15s by the history page +
// every dashboard load also fetches it — without a cache we did a full
// MinIO ListObjectsV2 round-trip on every hit. 30s TTL is well below
// the user-visible staleness threshold (a freshly-copied video appears
// within 30s of hitting MinIO) and cuts S3 API calls ~20x.
let _cache: { at: number; videos: StorageVideo[] } | null = null;
const CACHE_TTL_MS = 30_000;

/** List all `videos/*.mp4` objects in the primary bucket.
 *  Returns [] on any error — this is a best-effort augmentation, not
 *  a source of truth, so we swallow failures and let runs_index be the
 *  primary answer.
 *
 *  Cached for 30 seconds — dashboard + history poll this frequently. */
export async function listStorageVideos(): Promise<StorageVideo[]> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.videos;
  }
  const c = client();
  const bucket = process.env.S3_BUCKET || "yt-agent-videos";
  if (!c) return [];
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
          public_url: publicUrlFor(bucket, key),
        });
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (e) {
    // Best-effort; log and return whatever we already have.
    console.warn("listStorageVideos failed:", e);
  }
  _cache = { at: Date.now(), videos: out };
  return out;
}

/** Invalidate the storage listing cache. Call after a copy_storage
 *  side-job so the new video shows up in /api/runs on the next call
 *  instead of waiting for the 30s TTL. */
export function invalidateStorageCache(): void {
  _cache = null;
}
