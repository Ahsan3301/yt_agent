import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/runs/<run_id>/video
 *
 * Ownership-checked access to a rendered video.
 *
 * The MinIO bucket was created with `mc anonymous set download`, i.e.
 * world-readable. Object keys are `videos/<run_id>.mp4` where run_id
 * is a timestamp plus three characters, and those URLs were handed out
 * freely — embedded in Discord notifications, returned in API
 * responses, and stored in runs_index. Anyone who ever saw one could
 * fetch that customer's video forever, and could plausibly guess
 * neighbours.
 *
 * This route replaces direct bucket access: it verifies the caller
 * owns the run, then issues a short-lived presigned URL and redirects
 * to it. The signature is what grants access, so the bucket itself can
 * be closed.
 *
 * Deliberately a redirect rather than proxying the bytes: a render is
 * hundreds of megabytes, and streaming that through the Next.js
 * process would tie up the same single container that serves the whole
 * dashboard.
 */

const URL_TTL_SECONDS = 60 * 30;   // long enough to watch; short enough to not be a share link

let _s3: S3Client | null = null;
function s3(): S3Client | null {
  if (_s3) return _s3;
  const endpoint =
    process.env.S3_ENDPOINT_INTERNAL ||
    process.env.S3_ENDPOINT ||
    "";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.MINIO_ROOT_USER || "";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || "";
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  _s3 = new S3Client({
    endpoint,
    region: process.env.S3_REGION || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return _s3;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const { tenant } = auth;

  const { id } = await ctx.params;
  const runId = String(id || "").trim();
  if (!runId || runId.length > 80) {
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  }

  // Ownership. Superadmin can view anything; everyone else must own
  // the run. A run with no owner (pre-tenancy backlog) is treated as
  // the founder's rather than as public.
  try {
    const snap = await adminDb().collection("runs_index").doc(runId).get();
    if (snap.exists) {
      const d = (snap.data() || {}) as Record<string, unknown>;
      const owner = String(d.user_id || d.owner_user_id || "");
      if (!tenant.isSuper && owner && owner !== tenant.userId) {
        // 404 rather than 403 — a 403 would confirm the run exists.
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
    } else if (!tenant.isSuper) {
      // No DB row means we can't prove ownership, so don't serve it.
      // Superadmin keeps access for orphan-recovery work.
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  } catch {
    return NextResponse.json({ error: "lookup failed" }, { status: 500 });
  }

  const c = s3();
  const bucket = process.env.S3_BUCKET || "yt-agent-videos";
  if (!c) {
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });
  }

  try {
    const signed = await getSignedUrl(
      c,
      new GetObjectCommand({ Bucket: bucket, Key: `videos/${runId}.mp4` }),
      { expiresIn: URL_TTL_SECONDS },
    );
    // 302 so <video src> and download links follow it naturally.
    return NextResponse.redirect(signed, 302);
  } catch (e) {
    return NextResponse.json({ error: `could not sign: ${String(e).slice(0, 120)}` }, { status: 500 });
  }
}
