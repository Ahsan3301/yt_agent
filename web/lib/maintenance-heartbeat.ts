import { adminDb } from "@/lib/firebase-admin";

/**
 * Heartbeats for scheduled jobs.
 *
 * A cron job that stops running emits nothing — no error, no log line,
 * no alert — and "nothing" looks exactly like "nothing was due". Three
 * jobs were found dead on 2026-08-02 that way, one of them for a
 * fortnight and one that had never run at all. Each was found by a
 * human going and looking.
 *
 * Recording each run turns that into a staleness check the health page
 * can do continuously: a job that stops shows up as old rather than as
 * silence.
 *
 * Deliberately best-effort. A heartbeat write must never be able to
 * fail the work it is reporting on — an observability side-channel
 * that can break the thing it observes is worse than none.
 */

/** Expected cadence per job, seconds. A heartbeat older than roughly
 *  2x its interval means the job has stopped, not that it is between
 *  runs. Keep in sync with coolify/cron/crontab. */
export const MAINTENANCE_INTERVALS: Record<string, number> = {
  "scheduled-render":   3600,      // hourly
  "needs-worker":       180,       // */3 min
  "cleanup-stale":      900,       // */15 min
  "retry-publish":      1200,      // */20 min
  "check-connections":  86400,     // 06:30 daily
  "check-subscriptions":86400,     // 06:45 daily
  "check-pool":         14400,     // every 4h
  "cleanup":            86400,     // 05:00 daily
  "backup":             86400,     // 03:15 daily
};

export type Heartbeat = {
  job: string;
  last_run_at: number;
  last_ok_at: number;
  ok: boolean;
  detail: string;
  fail_streak: number;
};

/**
 * Record that `job` just ran. Never throws.
 *
 * `detail` should say what the run actually did ("requeued 2, failed
 * 0"), not that it ran — the timestamp already says that, and a run
 * that does nothing is exactly the case worth being able to see.
 */
export async function recordMaintenanceRun(
  job: string,
  ok: boolean,
  detail = "",
): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const ref = adminDb().collection("maintenance_runs").doc(job);
    let streak = 0;
    try {
      const prev = await ref.get();
      const p = (prev.data() || {}) as { fail_streak?: number };
      streak = ok ? 0 : Number(p.fail_streak || 0) + 1;
    } catch { /* first run, or unreadable — treat as fresh */ }

    const patch: Record<string, unknown> = {
      job,
      last_run_at: now,
      ok,
      detail: String(detail).slice(0, 300),
      fail_streak: streak,
    };
    if (ok) patch.last_ok_at = now;
    await ref.set(patch, { merge: true });
  } catch {
    // Swallowed on purpose — see the note at the top of this file.
  }
}

/**
 * Wrap a maintenance route handler so every outcome is recorded.
 *
 * Wrapping rather than adding a call before each `return`: these
 * routes have up to five return points, and the one that would get
 * missed is invariably an early error path — precisely the case the
 * heartbeat exists to capture.
 *
 * The response is cloned to read a short detail line. A failure to
 * parse it must not affect the response itself, so it is best-effort.
 */
export function withHeartbeat<TReq extends Request, TRes extends Response>(
  job: string,
  handler: (req: TReq) => Promise<TRes>,
): (req: TReq) => Promise<TRes> {
  return async (req: TReq) => {
    try {
      const res = await handler(req);
      let detail = "";
      try {
        const body = await res.clone().json() as Record<string, unknown>;
        detail = summarise(body);
      } catch { /* non-JSON or already consumed — timestamp still lands */ }
      await recordMaintenanceRun(job, res.status < 400, detail || `HTTP ${res.status}`);
      return res;
    } catch (e) {
      // A throw is the most important outcome to record, and the one
      // an inline call would have skipped.
      await recordMaintenanceRun(job, false, `threw: ${String(e).slice(0, 200)}`);
      throw e;
    }
  };
}

/** Compact one-line summary of a route's JSON response. Prefers counts
 *  over booleans — "requeued 2" is worth seeing, "ok: true" is not. */
function summarise(body: Record<string, unknown>): string {
  if (typeof body.error === "string" && body.error) return `error: ${body.error.slice(0, 120)}`;
  const bits: string[] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const push = (label: string, v: unknown) => {
    const n = num(v);
    if (n !== undefined && n > 0) bits.push(`${label} ${n}`);
  };
  push("queued", Array.isArray(body.queued) ? body.queued.length : body.queued);
  push("stranded", body.stranded);
  push("checked", body.checked);
  push("broken", body.broken);
  push("run_logs_deleted", body.run_logs_deleted);
  const oj = body.orphan_jobs as { handled?: number } | undefined;
  if (oj && num(oj.handled)) bits.push(`orphans ${oj.handled}`);
  const sb = body.stale_backends as { deleted?: number } | undefined;
  if (sb && num(sb.deleted)) bits.push(`stale_backends ${sb.deleted}`);
  if (body.skipped === true) bits.push("skipped");
  if (body.woke === true) bits.push("woke worker");
  return bits.join(", ").slice(0, 300);
}

/** All heartbeats, with staleness computed against the expected
 *  cadence. `stale` is the signal the health page should surface. */
export async function readHeartbeats(): Promise<Array<Heartbeat & {
  age_seconds: number | null;
  expected_seconds: number | null;
  stale: boolean;
  never_ran: boolean;
}>> {
  const now = Math.floor(Date.now() / 1000);
  const rows = new Map<string, Heartbeat>();
  try {
    const snap = await adminDb().collection("maintenance_runs").limit(100).get();
    snap.forEach((d) => {
      const v = (d.data() || {}) as Partial<Heartbeat>;
      const job = String(v.job || d.id);
      rows.set(job, {
        job,
        last_run_at: Number(v.last_run_at || 0),
        last_ok_at:  Number(v.last_ok_at || 0),
        ok:          Boolean(v.ok),
        detail:      String(v.detail || ""),
        fail_streak: Number(v.fail_streak || 0),
      });
    });
  } catch { /* fall through — every known job reports as never-ran */ }

  // Iterate the EXPECTED set, not what happens to be in the table. A
  // job that has never written a heartbeat is the most important case
  // to show, and reading only stored rows would omit exactly that.
  return Object.keys(MAINTENANCE_INTERVALS).map((job) => {
    const r = rows.get(job);
    const expected = MAINTENANCE_INTERVALS[job] ?? null;
    const last = r?.last_run_at || 0;
    const age = last > 0 ? now - last : null;
    return {
      job,
      last_run_at: last,
      last_ok_at:  r?.last_ok_at || 0,
      ok:          r?.ok ?? false,
      detail:      r?.detail || "",
      fail_streak: r?.fail_streak || 0,
      age_seconds: age,
      expected_seconds: expected,
      never_ran: last === 0,
      // 2x cadence + a minute of slack: late enough that normal jitter
      // and a deploy restart don't cry wolf, early enough that a job
      // which has genuinely stopped is obvious within one cycle.
      stale: last === 0 || (expected != null && age != null && age > expected * 2 + 60),
    };
  }).sort((a, b) => Number(b.stale) - Number(a.stale) || a.job.localeCompare(b.job));
}
