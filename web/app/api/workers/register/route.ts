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

    // Read existing doc first so we can PRESERVE dashboard-set fields
    // that the worker's heartbeat body would otherwise clobber:
    //   - shutdown_pending: set by /api/backends/[id]/shutdown when the
    //     user clicks Terminate. If we blindly overwrite with the
    //     worker's status='available', the flag is lost, the worker's
    //     next claim poll never sees it, and Terminate is a no-op.
    const existingSnap = await adminDb().collection("backends").doc(instance_id).get();
    const existing = existingSnap.exists ? (existingSnap.data() || {}) : {};
    const shutdown_pending = !!existing.shutdown_pending;

    // Short-circuit: if the dashboard has flagged this worker for
    // shutdown, do NOT refresh its last_seen_at or reset its status.
    // Reason: a zombie worker on pre-SIGKILL code that ignores the
    // shutdown signal was previously keeping its row alive forever
    // via heartbeats, so the Monitor card kept re-appearing after
    // Terminate. Now the row goes stale (no last_seen_at bumps) and
    // the frontend's 3-min freshness filter hides it. We still echo
    // shutdown:true in the response so a NEW-code worker exits
    // immediately on the same call.
    if (shutdown_pending) {
      return NextResponse.json({
        ok:       true,
        id:       instance_id,
        shutdown: true,
        note:     "shutdown_pending set; row will not be refreshed until it is deleted or the flag is cleared",
      });
    }

    // Sample rate: heartbeats can arrive with stats (cpu/mem/gpu/disk)
    // in the body. Passing them through means the Monitor page reads
    // fresh numbers from PB without needing an inbound URL on the
    // worker. Absent = clear the field so old stats don't stick.
    const stats = (body.stats && typeof body.stats === "object") ? body.stats : null;

    const doc: Record<string, unknown> = {
      instance_id,
      label:          String(body.label || "").slice(0, 80),
      tier:           String(body.tier || "gpu").slice(0, 20),
      gpu_name:       String(body.gpu_name || "").slice(0, 128),
      status:         String(body.status || "available").slice(0, 32),
      // url is intentionally empty for outbound-poll workers — they
      // have no addressable endpoint.
      url:            String(body.url || "").slice(0, 400),
      mode:           "outbound_poll",
      started_at:     Number(body.started_at) || Date.now() / 1000,
      last_seen_at:   Date.now() / 1000,
      active_job_id:  String(body.active_job_id || "").slice(0, 64),
      updated_at:     FieldValue.serverTimestamp(),
      // Preserve the dashboard-controlled shutdown flag across heartbeats.
      shutdown_pending,
    };
    if (stats) doc.stats = stats;

    await adminDb().collection("backends").doc(instance_id).set(doc, { merge: true });
    return NextResponse.json({
      ok: true,
      id: instance_id,
      registered_at: doc.last_seen_at,
      // Echo the flag so the worker can early-exit without a separate
      // claim call — saves one round-trip on shutdown latency.
      shutdown: shutdown_pending,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
