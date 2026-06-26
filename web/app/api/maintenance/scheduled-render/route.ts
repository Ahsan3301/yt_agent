import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { pickWorkers, newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/scheduled-render
 *
 * Daily cron from GitHub Actions. Reads schedules/default and queues
 * the configured number of jobs per channel.
 *
 * - Returns `{ skipped: true }` if `enabled=false` in the schedule doc.
 * - Otherwise queues `daily_targets[channel]` jobs per channel.
 * - Each job is created with `dry_run=!publish_default`.
 *
 * Auth: X-API-Key matching api_keys/RENDER_TRIGGER_KEY.
 */
const SCHEDULE_DOC = ["schedules", "default"] as const;
const DEFAULT_SCHEDULE = {
  enabled: false,
  daily_targets: { horror: 1, wisdom: 0 } as Record<string, number>,
  publish_default: true,
  buffer_seconds: 0,
};

export async function POST(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  try {
    const snap = await adminDb()
      .collection(SCHEDULE_DOC[0])
      .doc(SCHEDULE_DOC[1])
      .get();
    const data = snap.exists ? (snap.data() || {}) : DEFAULT_SCHEDULE;
    const enabled = !!data.enabled;
    if (!enabled) {
      logRoute(reqId, "schedule disabled");
      return NextResponse.json({
        skipped: true,
        reason: "scheduler disabled",
        req_id: reqId,
      });
    }

    const targets = (data.daily_targets || {}) as Record<string, number>;
    const publish = data.publish_default !== false;
    const dry_run = !publish;

    const workers = await pickWorkers();
    const targetWorker = workers[0];

    const queued: { job_id: string; channel: string; backend_url: string | null }[] = [];
    for (const [channel, count] of Object.entries(targets)) {
      for (let i = 0; i < count; i++) {
        const jobId = _shortId();
        const job = {
          id: jobId,
          status: targetWorker ? "running" : "queued",
          channel,
          dry_run,
          queued_at: Date.now() / 1000,
          started_at: targetWorker ? Date.now() / 1000 : null,
          finished_at: null,
          percent: 0,
          current_step: null,
          current_step_label: null,
          video_url: null,
          public_url: null,
          error: null,
          run_id: null,
          backend_instance_id: targetWorker?.instance_id || null,
          backend_url: targetWorker?.url || null,
          created_by: "scheduled-render",
          req_id: reqId,
          updated_at: FieldValue.serverTimestamp(),
        };
        await adminDb().collection("jobs").doc(jobId).set(job);

        // Best-effort dispatch — workers will also pull from the queue.
        if (targetWorker) {
          fetch(`${targetWorker.url.replace(/\/$/, "")}/api/jobs`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": reqId,
              "X-Vercel-Gateway": "scheduled",
            },
            body: JSON.stringify({ channel, dry_run }),
          }).catch(() => {});
        }
        queued.push({ job_id: jobId, channel, backend_url: targetWorker?.url || null });
      }
    }

    logRoute(reqId, "scheduled-render queued", { count: queued.length });
    return NextResponse.json({
      ok: true,
      queued,
      worker_available: !!targetWorker,
      req_id: reqId,
    });
  } catch (e) {
    logRoute(reqId, "scheduled-render failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function _shortId(): string {
  const a = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 12; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}
