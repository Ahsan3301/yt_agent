/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0025 — heartbeats for scheduled jobs.
 *
 * Why
 * ---
 * The most expensive failures on this platform are scheduled jobs that
 * stop running. They produce no error, because they produce nothing at
 * all — and "nothing" is indistinguishable from "nothing was due".
 * Found on 2026-08-02, all silent, none younger than a fortnight:
 *
 *   - the gateway-heal watchdog had been dead ~2 weeks (a '#' in the
 *     crontab truncated the command; it failed at parse time on every
 *     tick and the recovery it provides simply did not exist)
 *   - nightly offsite backups had NEVER run — the instruction said to
 *     install a host crontab entry and the VPS has no cron daemon
 *   - scheduled-render lost a channel's whole day whenever a deploy
 *     overlapped its hour
 *
 * Each was found by hand, by going and looking. This table makes the
 * next one visible instead: every maintenance route stamps its name,
 * outcome and timestamp here, and the health page shows the age. A job
 * that stops running goes stale on screen rather than disappearing.
 *
 * One row per job name (upsert), not an audit log — the question is
 * "is this alive", not "what did it do in March". Keeps the table at
 * roughly a dozen rows forever, which matters on a single SQLite file
 * that already carries 60k run_logs.
 */
migrate((app) => {
  function ensure(name, schemaFn) {
    try {
      const existing = app.findCollectionByNameOrId(name);
      if (existing) { console.log(`[pb-migrate] ${name}: exists, skipping`); return; }
    } catch (_e) { /* create */ }
    app.save(schemaFn());
    console.log(`[pb-migrate] ${name}: created`);
  }

  // Admin-token only, matching every other operator collection.
  const ADMIN_ONLY = null;

  ensure("maintenance_runs", () => new Collection({
    name: "maintenance_runs",
    type: "base",
    fields: [
      // Route name, e.g. "cleanup-stale", "retry-publish", "backup".
      { name: "job",          type: "text",   max: 60, required: true },
      { name: "last_run_at",  type: "number" },
      // Last run that finished without throwing.
      { name: "last_ok_at",   type: "number" },
      { name: "ok",           type: "bool" },
      // Short outcome summary, e.g. "requeued 2, failed 0".
      { name: "detail",       type: "text",   max: 300 },
      // Consecutive failures — lets the UI distinguish a blip from a
      // job that has been broken since the last time anyone looked.
      { name: "fail_streak",  type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_maintenance_runs_job ON maintenance_runs (job)",
    ],
    listRule:   ADMIN_ONLY,
    viewRule:   ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
  }));

  console.log("[pb-migrate] 0025_maintenance_heartbeats: done");
}, (app) => { /* additive-only */ });
