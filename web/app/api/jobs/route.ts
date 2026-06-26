import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import {
  pickWorkers, newRequestId, logRoute, upsertJob,
  lookupIdempotent, storeIdempotent,
} from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";   // never cache; this is orchestration
export const runtime = "nodejs";          // firebase-admin needs node runtime

/**
 * GET /api/jobs — list recent jobs from Firestore (most-recent first).
 * Replaces the old behaviour of polling each backend for its local jobs.
 */
export async function GET() {
  const reqId = newRequestId();
  try {
    const snap = await adminDb()
      .collection("jobs")
      .orderBy("queued_at", "desc")
      .limit(50)
      .get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data();
      out.push({ ...d, id: d.id || doc.id });
    });
    logRoute(reqId, "list jobs", { count: out.length });
    return NextResponse.json(out);
  } catch (e) {
    logRoute(reqId, "list jobs failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * POST /api/jobs — submit a new pipeline run.
 *
 * Always succeeds: if a worker is alive, dispatches immediately. If
 * not, queues the job in Firestore — the next worker that heartbeats
 * picks it up via the registry.py claim loop.
 *
 * Idempotent on the optional `Idempotency-Key` request header: if the
 * same key was used in the last 60 seconds, returns the previously-
 * created job instead of creating a duplicate.
 */
export async function POST(req: NextRequest) {
  const reqId = newRequestId();
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const channel = String(body.channel || "horror");
    const dry_run = body.dry_run !== false; // default true (dry run)

    // Idempotency check.
    const idempKey = req.headers.get("Idempotency-Key") || "";
    if (idempKey) {
      const existing = await lookupIdempotent(idempKey);
      if (existing) {
        logRoute(reqId, "idempotent replay", { key: idempKey, job_id: existing });
        const doc = await adminDb().collection("jobs").doc(existing).get();
        if (doc.exists) return NextResponse.json(doc.data());
      }
    }

    // Synthesize the job row (same shape as backend/jobs.py's submit).
    const jobId = _shortId();
    const now = Date.now() / 1000;
    const base = {
      id: jobId,
      status: "queued",
      channel,
      dry_run,
      queued_at: now,
      started_at: null,
      finished_at: null,
      percent: 0,
      current_step: null,
      current_step_label: null,
      video_url: null,
      public_url: null,
      error: null,
      run_id: null,
      backend_instance_id: null,
      backend_url: null,
      created_by: "vercel-gateway",
      req_id: reqId,
    };

    // Pick a worker. If one is alive, dispatch immediately.
    const workers = await pickWorkers();
    const target = workers[0];

    if (target) {
      logRoute(reqId, "dispatching", { backend: target.instance_id, url: target.url });
      try {
        const r = await fetch(`${target.url.replace(/\/$/, "")}/api/jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": reqId,
            "X-Vercel-Gateway": "1",
          },
          body: JSON.stringify({ channel, dry_run }),
        });
        if (r.ok) {
          const workerJob = await r.json();
          // Replace the synthetic id with the worker's id so subsequent
          // status checks find the same record. (Backend's submit()
          // already wrote to Firestore on the first _persist, so the
          // doc lives at jobs/<workerJob.id>, NOT jobs/<jobId>.)
          const finalId = workerJob.id || jobId;
          await upsertJob(finalId, {
            ...workerJob,
            backend_instance_id: target.instance_id,
            backend_url: target.url,
            req_id: reqId,
          });
          if (idempKey) await storeIdempotent(idempKey, finalId);
          return NextResponse.json(workerJob);
        }
        logRoute(reqId, "dispatch http error", { status: r.status });
      } catch (e) {
        logRoute(reqId, "dispatch network error", { err: String(e) });
      }
    }

    // No worker reachable — queue the job for later pickup. The worker
    // claim loop in backend/registry.py will adopt it on next heartbeat.
    await adminDb().collection("jobs").doc(jobId).set({
      ...base,
      updated_at: FieldValue.serverTimestamp(),
    });
    if (idempKey) await storeIdempotent(idempKey, jobId);
    logRoute(reqId, "queued (no worker)", { job_id: jobId });
    return NextResponse.json(base);
  } catch (e) {
    logRoute(reqId, "POST jobs failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function _shortId(): string {
  const a = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 12; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}
