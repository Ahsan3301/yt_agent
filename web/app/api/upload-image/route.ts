import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Dashboard container is directly wired to MinIO in Coolify — we upload
// straight there instead of proxying to a worker. The old proxy path
// only worked in tunnel-mode when workers exposed HTTP endpoints; in
// outbound-poll mode (the only mode Coolify+Kaggle uses today) workers
// have no callable URL, so pickWorkers() returned empty and /create
// showed "no worker available to stage the upload" indefinitely.
//
// Multipart body limit stays at 4 MB — same as the old proxy — because
// the client already downscales anything larger.
export const maxDuration = 30;

const _ALLOWED_EXT: Record<string, string> = {
  "image/png":  ".png",
  "image/webp": ".webp",
  "image/gif":  ".gif",
  "image/jpeg": ".jpg",
  "image/jpg":  ".jpg",
};

const _MAX_BYTES = 8 * 1024 * 1024;   // 8 MB, matches backend/server.py

function _s3Client() {
  return new S3Client({
    endpoint:
      process.env.S3_ENDPOINT_INTERNAL ||
      process.env.S3_ENDPOINT ||
      "http://minio:9000",
    region: process.env.S3_REGION || "us-east-1",
    credentials: {
      accessKeyId:
        process.env.S3_ACCESS_KEY_ID    || process.env.MINIO_ROOT_USER     || "",
      secretAccessKey:
        process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || "",
    },
    forcePathStyle: true,
  });
}

/**
 * POST /api/upload-image (multipart/form-data, field: file)
 *
 * Uploads a user-provided image (JPG / PNG / WebP / GIF, up to 8 MB) to
 * MinIO at key `staging/<uuid>.<ext>` and returns:
 *
 *   { ok: true, url, key, size }
 *
 * Same response shape as the old worker-proxy handler (and the
 * matching backend/server.py:upload_image), so no client-side change
 * needed. The `staging/*` prefix is what the existing cleanup-stale
 * cron already prunes after 7 days.
 */
export async function POST(req: NextRequest) {
  const bucket    = process.env.S3_BUCKET || "yt-agent-videos";
  const accessKey = process.env.S3_ACCESS_KEY_ID    || process.env.MINIO_ROOT_USER     || "";
  const secretKey = process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || "";
  if (!accessKey || !secretKey) {
    return NextResponse.json(
      {
        error:  "storage not configured",
        detail: "S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (or MINIO_ROOT_USER / MINIO_ROOT_PASSWORD) must be set on the dashboard container",
      },
      { status: 503 },
    );
  }

  let file: File;
  try {
    const formData = await req.formData();
    const raw = formData.get("file");
    if (!raw || typeof raw === "string") {
      return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
    }
    file = raw as File;
  } catch (e) {
    return NextResponse.json({ error: "invalid multipart body", detail: String(e) }, { status: 400 });
  }

  const contentType = (file.type || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    return NextResponse.json({ error: `expected image/*, got '${contentType || "unknown"}'` }, { status: 400 });
  }
  if (file.size > _MAX_BYTES) {
    return NextResponse.json({ error: `image must be < ${_MAX_BYTES / (1024 * 1024)} MB` }, { status: 413 });
  }

  const ext = _ALLOWED_EXT[contentType] ?? ".jpg";
  const key = `staging/${randomUUID().replace(/-/g, "")}${ext}`;
  const body = Buffer.from(await file.arrayBuffer());

  try {
    const s3 = _s3Client();
    await s3.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        body,
      ContentType: contentType,
    }));
  } catch (e) {
    return NextResponse.json({ error: "MinIO upload failed", detail: String(e) }, { status: 500 });
  }

  // Public URL — the base the worker will download from. Priority:
  //   1. S3_PUBLIC_BASE (server-side, wins on Coolify).
  //   2. NEXT_PUBLIC_S3_PUBLIC_BASE (already set on current deploy for
  //      the frontend video player; safe to reuse here).
  //   3. Reconstruct from X-Forwarded-Host/Proto (Caddy sets these).
  //   4. Fall back to req.nextUrl.origin — LAST resort, breaks when
  //      Next.js binds to 0.0.0.0 (Kaggle worker downloads got
  //      http://0.0.0.0:3000/... and connection-refused'd).
  const rawBase =
    process.env.S3_PUBLIC_BASE ||
    process.env.NEXT_PUBLIC_S3_PUBLIC_BASE ||
    "";
  let baseUrl = rawBase.trim().replace(/\/$/, "");
  if (!baseUrl) {
    const fwdHost  = req.headers.get("x-forwarded-host")  || req.headers.get("host") || "";
    const fwdProto = req.headers.get("x-forwarded-proto") || "https";
    if (fwdHost && fwdHost !== "0.0.0.0:3000") {
      baseUrl = `${fwdProto}://${fwdHost}/${bucket}`;
    } else {
      baseUrl = `${req.nextUrl.origin.replace(/\/$/, "")}/${bucket}`;
    }
  }
  const url = `${baseUrl}/${key}`;

  return NextResponse.json({
    ok:   true,
    url,
    key,
    size: file.size,
  });
}
