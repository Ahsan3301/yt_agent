import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/jobs/claim
 *
 * Atomic claim — the worker pulls the oldest unclaimed job and the
 * server marks it as taken-by-<instance_id> in one shot. Returns the
 * full job payload OR 204 No Content when nothing is queued.
 *
 * Used by outbound-poll workers (see /api/workers/register). The
 * worker calls this on a 5-second cadence; when it gets a hit, it
 * runs the pipeline and posts back progress via the existing
 * /api/jobs/<id> patch path.
 *
 * Atomicity: Firestore transactions OR Pocketbase PATCH-with-filter.
 * We use a single PATCH that only succeeds if the status is still
 * 'queued' AND backend_instance_id is empty — anything else means
 * another worker grabbed it between our list and our update.
 *
 * Request body:
 *   {
 *     instance_id,        // who's claiming
 *     channel?: string,   // optional filter — claim only matching channel
 *     tier?: "gpu"|"cpu", // optional filter
 *   }
 *
 * Auth: X-API-Key matching RENDER_TRIGGER_KEY.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("x-api-key") || "";
  const expected = process.env.RENDER_TRIGGER_KEY || "";
  if (!expected || auth !== expected) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const instance_id = String(body.instance_id || "").slice(0, 128);
    if (!instance_id) {
      return NextResponse.json({ error: "instance_id required" }, { status: 400 });
    }

    const db = adminDb();

    // Termination signal — dashboard sets shutdown_pending on the
    // worker's backends record. This is a SEPARATE field from
    // status/last_seen_at so the heartbeat register route can't
    // clobber it. Worker's next claim poll sees the flag and exits.
    try {
      const backSnap = await db.collection("backends").doc(instance_id).get();
      if (backSnap.exists) {
        const bd = backSnap.data() as { shutdown_pending?: boolean; status?: string };
        // Accept both the new bool field and the legacy status string
        // for one release cycle.
        if (bd.shutdown_pending || bd.status === "shutdown_requested") {
          return NextResponse.json({ ok: true, shutdown: true, job: null });
        }
      }
    } catch { /* soft-fail, keep polling */ }
    // Pull a small batch of unclaimed jobs, then race-loss on the first
    // one we can grab. Five candidates per call keeps the contention
    // window short — multiple workers polling the same second will
    // collide on candidate 1, succeed on candidate 2+ instead of
    // hammering the same row.
    const snap = await db.collection("jobs")
      .where("status", "==", "queued")
      .orderBy("queued_at", "asc")
      .limit(5)
      .get();

    if (snap.empty) {
      return new NextResponse(null, { status: 204 });
    }

    const now = Date.now() / 1000;
    const workerTier = String(body.tier || "gpu");   // 'gpu' | 'cpu' | 'dashboard'
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      // Filter — if the worker only handles a specific channel.
      if (body.channel && data.channel !== body.channel) continue;

      // Schedule gate: never claim a job whose run_at is in the future.
      const runAt = Number(data.run_at ?? 0);
      if (runAt > 0 && runAt > now) continue;

      // Target gate: `target_worker` on the job is one of:
      //   ""            → any worker (default; unchanged behaviour)
      //   "gpu"         → any GPU worker
      //   "dashboard"   → the Oracle-hosted side-worker only
      //   "<instance_id>" → that specific worker
      const target = String(data.target_worker || "");
      if (target) {
        if (target === "dashboard" && workerTier !== "dashboard") continue;
        if (target === "gpu"       && workerTier !== "gpu")       continue;
        if (target === "cpu"       && workerTier === "gpu")       continue;
        if (
          target !== "dashboard" && target !== "gpu" && target !== "cpu" &&
          target !== instance_id
        ) continue;
      }

      // Conditional update — only succeed if the doc is still queued.
      try {
        await doc.ref.update({
          status:               "claimed",
          backend_instance_id:  instance_id,
          claimed_at:           now,
          updated_at:           FieldValue.serverTimestamp(),
        });
        return NextResponse.json({
          ok:   true,
          job:  { id: doc.id, ...data,
                  status: "claimed",
                  backend_instance_id: instance_id },
        });
      } catch {
        // Race lost — try the next candidate.
        continue;
      }
    }

    // All candidates raced away.
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
