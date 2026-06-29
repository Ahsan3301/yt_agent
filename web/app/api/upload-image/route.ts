import { NextRequest, NextResponse } from "next/server";
import { pickWorkers } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Vercel has a 4.5 MB default body limit on serverless functions. The
// worker accepts up to 8 MB; we keep the Vercel-side limit at 4 MB so
// the proxy can buffer the upload. Larger images get downscaled
// client-side in the dashboard before hitting this route.
export const maxDuration = 30;

/**
 * POST /api/upload-image (multipart/form-data, field: file)
 *
 * Proxies the upload to an alive worker's /api/upload-image which
 * stages it on R2 and returns the public URL. The URL gets passed
 * into POST /api/jobs as manual_images[] so the worker can fetch it
 * when claiming the render.
 *
 * Why proxy through a worker instead of writing to R2 from Vercel?
 * Because R2 creds live in Firestore api_keys now — they're not on
 * Vercel. The worker is the only thing with R2 SDK + creds in scope.
 */
export async function POST(req: NextRequest) {
  const workers = await pickWorkers();
  // We only need ANY worker — R2 is shared. Prefer GPU since they
  // tend to be more recent, but any alive instance works.
  const target = workers[0];
  if (!target) {
    return NextResponse.json(
      {
        error: "no worker available to stage the upload",
        next_step:
          "Launch a Colab/Kaggle/HF worker first. Image staging happens worker-side because that's where the R2 credentials live.",
      },
      { status: 503 },
    );
  }

  // Stream the multipart body through unchanged.
  const formData = await req.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "missing 'file' field" }, { status: 400 });
  }

  // Rebuild a fresh FormData (Next.js' parsed FormData isn't directly
  // re-usable as a fetch body across all runtimes).
  const upstream = new FormData();
  upstream.append("file", file);

  try {
    const r = await fetch(`${target.url.replace(/\/$/, "")}/api/upload-image`, {
      method: "POST",
      body: upstream,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return NextResponse.json(
        { error: `worker returned ${r.status}`, detail: body },
        { status: 502 },
      );
    }
    return NextResponse.json({ ...body, worker: target.instance_id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
