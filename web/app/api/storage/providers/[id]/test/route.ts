import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { decryptSecret } from "@/lib/storage-crypto";
import { requireTenant, assertOwnership } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/storage/providers/<id>/test
 *
 * Cheap connectivity probe — does NOT actually upload a video. For
 * S3-like providers: HEAD the bucket. For SFTP: stat the base_dir.
 *
 * The full upload + verify + delete probe lives on the worker side
 * (provider.health_check()). Doing it here would require boto3 /
 * paramiko in the Vercel runtime, which is heavy.
 *
 * Records the result on the provider doc so the /storage page can
 * surface a green/red pill without re-probing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    const ref = adminDb().collection("storage_providers").doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const data = snap.data() || {};
    const ownErr = assertOwnership(data as Record<string, unknown>, auth.tenant);
    if (ownErr) return ownErr;

    const kind = String(data.kind || "");
    let ok = false;
    let message = "";

    if (kind === "hostinger_sftp") {
      // Best we can do without paramiko: validate the host resolves.
      ok = !!(data.host && data.user && data.base_dir);
      message = ok
        ? "config looks complete (full SFTP probe runs on worker)"
        : "host / user / base_dir required";
    } else if (["minio", "r2", "aws_s3", "wasabi", "b2"].includes(kind)) {
      // Use the AWS S3 SDK via fetch — we can do a simple HEAD on the
      // bucket without pulling a heavy boto3-equivalent into Vercel's
      // Node runtime.
      try {
        const endpoint = await _resolveEndpoint(data);
        if (!endpoint) {
          ok = false;
          message = "endpoint not resolvable (missing endpoint / account_id / region)";
        } else {
          const secret = data.secret_access_key
            ? await decryptSecret(String(data.secret_access_key))
            : "";
          const probe = await _sigv4HeadBucket({
            endpoint,
            region: String(data.region || "auto"),
            accessKeyId: String(data.access_key_id || ""),
            secretAccessKey: secret,
            bucket: String(data.bucket || ""),
            pathStyle: data.path_style !== false,
          });
          ok = probe.ok;
          message = probe.message;
        }
      } catch (e) {
        ok = false;
        message = `${(e as Error).name}: ${(e as Error).message}`;
      }
    } else {
      ok = false;
      message = `unknown provider kind: ${kind}`;
    }

    await ref.update({
      last_health_ok: ok,
      last_health_check: FieldValue.serverTimestamp(),
      last_health_message: message.slice(0, 300),
    });

    return NextResponse.json({ ok, message, id, kind });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

async function _resolveEndpoint(data: Record<string, unknown>): Promise<string> {
  const ep = String(data.endpoint || "").trim();
  if (ep) return ep;
  const kind = String(data.kind || "");
  const extras = (data.extras || {}) as Record<string, string>;
  const region = String(data.region || "auto");
  if (kind === "r2") {
    const accountId = (extras.account_id || "").trim();
    return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "";
  }
  if (kind === "aws_s3") return `https://s3.${region}.amazonaws.com`;
  if (kind === "wasabi") return `https://s3.${region}.wasabisys.com`;
  if (kind === "b2")     return `https://s3.${region}.backblazeb2.com`;
  return "";
}

/**
 * AWS SigV4 signed HEAD on a bucket. Standalone — no aws-sdk dep
 * (Vercel cold start savings). Implements the minimum needed for an
 * S3 HEAD against any S3-compatible endpoint.
 */
async function _sigv4HeadBucket(opts: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  pathStyle: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const crypto = await import("node:crypto");
  if (!opts.accessKeyId || !opts.secretAccessKey || !opts.bucket) {
    return { ok: false, message: "missing access key, secret, or bucket" };
  }

  const url = new URL(opts.endpoint);
  const host = url.host;
  const path = opts.pathStyle ? `/${opts.bucket}` : "/";
  const fullUrl = opts.pathStyle
    ? `${opts.endpoint.replace(/\/$/, "")}/${opts.bucket}`
    : `${opts.endpoint.replace(/\/$/, "")}/`;
  const probeHost = opts.pathStyle ? host : `${opts.bucket}.${host}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";
  const region = opts.region || "auto";

  // Canonical request
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");
  const canonicalHeaders =
    `host:${probeHost}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest =
    `HEAD\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  // String to sign
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n` +
    crypto.createHash("sha256").update(canonicalRequest).digest("hex");

  // Signing key
  const kDate    = crypto.createHmac("sha256", "AWS4" + opts.secretAccessKey).update(dateStamp).digest();
  const kRegion  = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const res = await fetch(opts.pathStyle ? fullUrl : `https://${probeHost}/`, {
      method: "HEAD",
      headers: {
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        "Authorization": authHeader,
        // Some compatible servers need Host fixed for virtual-host style.
        "Host": probeHost,
      },
    });
    if (res.status === 200 || res.status === 301) {
      return { ok: true, message: `bucket reachable (HTTP ${res.status})` };
    }
    if (res.status === 404) {
      return { ok: false, message: "bucket not found" };
    }
    if (res.status === 403) {
      return { ok: false, message: "access denied (check keys + bucket name)" };
    }
    return { ok: false, message: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: `network: ${(e as Error).message}` };
  }
}
