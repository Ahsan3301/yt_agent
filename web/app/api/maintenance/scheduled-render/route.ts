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
    // Loose typing — the Firestore doc shape evolves over time
    // (web_research was added later) so cast to a permissive record
    // and read fields defensively.
    const data: Record<string, unknown> = snap.exists
      ? (snap.data() || {}) as Record<string, unknown>
      : (DEFAULT_SCHEDULE as Record<string, unknown>);
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
    const skipped: { channel: string; reason: string }[] = [];
    for (const [channel, count] of Object.entries(targets)) {
      // Sanity-check the channel name. Reject empties / overlong /
      // whitespace-only entries so an invalid Firestore edit doesn't
      // queue garbage jobs.
      const cleanChannel = String(channel || "").trim();
      const safeCount = Math.max(0, Math.min(10, Number(count) || 0));
      if (!cleanChannel || cleanChannel.length > 60) {
        skipped.push({ channel, reason: "invalid channel name (empty / too long)" });
        continue;
      }
      if (safeCount === 0) continue;
      for (let i = 0; i < safeCount; i++) {
        const jobId = _shortId();
        // Status: "queued" with no backend until a worker actually
        // accepts the dispatch. The optimistic "running" in the old
        // code was misleading — workers may not actually be reachable.
        const job = {
          id: jobId,
          status: "queued" as const,
          channel: cleanChannel,
          dry_run,
          queued_at: Date.now() / 1000,
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
          created_by: "scheduled-render",
          req_id: reqId,
          // Scheduled renders inherit the channel's web_research default
          // unless the schedule doc overrides it. Defaults to null →
          // backend uses channel default.
          web_research: data.web_research === true ? true
                       : data.web_research === false ? false
                       : null,
          updated_at: FieldValue.serverTimestamp(),
        };
        await adminDb().collection("jobs").doc(jobId).set(job);

        // Best-effort dispatch — workers will also pull from the queue
        // via their claim loop. The dispatch tries the new manual-mode
        // params too in case the schedule grew a topic seed later.
        if (targetWorker) {
          fetch(`${targetWorker.url.replace(/\/$/, "")}/api/jobs`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": reqId,
              "X-Vercel-Gateway": "scheduled",
            },
            body: JSON.stringify({
              channel: cleanChannel,
              dry_run,
              web_research: job.web_research,
            }),
          }).catch(() => {});
        }
        queued.push({ job_id: jobId, channel: cleanChannel, backend_url: targetWorker?.url || null });
      }
    }

    logRoute(reqId, "scheduled-render queued", { count: queued.length, skipped: skipped.length });
    return NextResponse.json({
      ok: true,
      queued,
      skipped,
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
