import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/workers/register
 *
 * Worker self-registration endpoint for OUTBOUND-POLL mode.
 *
 * Replaces the older inbound-tunnel flow:
 *   - Old flow: worker exposes a cloudflared tunnel → posts URL to
 *               backends collection → dashboard polls the URL.
 *   - New flow: worker has NO public URL. It POSTs here on boot +
 *               heartbeats. Then it pulls jobs from /api/jobs/claim.
 *
 * This lets free GPU workers (Colab, Kaggle) skip the tunnel reset
 * dance entirely — outbound HTTPS is reliable; inbound tunnels are not.
 *
 * Body shape mirrors what backend/registry.py's _self_payload sends:
 *   {
 *     instance_id, label, tier, gpu_name, status,
 *     active_job_id?, started_at, last_seen_at
 *   }
 *
 * Auth: X-API-Key matching RENDER_TRIGGER_KEY OR a valid Pocketbase
 * service token (PB_SERVER_TOKEN). The same shared-secret pattern the
 * maintenance routes use.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("x-api-key") || "";
  const expected = process.env.RENDER_TRIGGER_KEY || "";
  if (!expected || auth !== expected) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const instance_id = String(body.instance_id || "").slice(0, 128);
    if (!instance_id) {
      return NextResponse.json({ error: "instance_id required" }, { status: 400 });
    }

    const doc = {
      instance_id,
      label:          String(body.label || "").slice(0, 80),
      tier:           String(body.tier || "gpu").slice(0, 8),
      gpu_name:       String(body.gpu_name || "").slice(0, 128),
      status:         String(body.status || "available").slice(0, 32),
      // url is intentionally empty for outbound-poll workers — they
      // have no addressable endpoint. The dashboard's job dispatch
      // path checks `mode==='outbound_poll' || url===''` to skip the
      // try-to-POST-the-worker step.
      url:            String(body.url || "").slice(0, 400),
      mode:           "outbound_poll",
      started_at:     Number(body.started_at) || Date.now() / 1000,
      last_seen_at:   Date.now() / 1000,
      active_job_id:  String(body.active_job_id || "").slice(0, 64),
      updated_at:     FieldValue.serverTimestamp(),
    };

    await adminDb().collection("backends").doc(instance_id).set(doc, { merge: true });
    return NextResponse.json({ ok: true, id: instance_id, registered_at: doc.last_seen_at });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
