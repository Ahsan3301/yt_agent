/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0004 — cleanup_runs collection.
 *
 * Persistent log of every cleanup operation (both cron + operator-triggered).
 * Powers /reports "cleanup history" panel — we don't rely on the ephemeral
 * response of /api/maintenance/cleanup-now, so the operator can audit
 * what was deleted and when.
 *
 * Also adds a `cleanup_password` field to settings collection (as a
 * doc rather than a schema field — we store it in settings/cleanup_password
 * with `hash` sub-field, so no schema change is needed on `settings`;
 * PB accepts arbitrary JSON blobs on the `data` field).
 */
migrate((app) => {
  function ensure(name, schemaFn) {
    try {
      const existing = app.findCollectionByNameOrId(name);
      if (existing) { console.log(`[pb-migrate] ${name}: exists, skipping`); return; }
    } catch (_e) { /* not found → create */ }
    const coll = schemaFn();
    app.save(coll);
    console.log(`[pb-migrate] ${name}: created`);
  }
  const OPEN = "";
  const SUPERUSER_ONLY = null;

  ensure("cleanup_runs", () => new Collection({
    name: "cleanup_runs",
    type: "base",
    fields: [
      { name: "ts",                    type: "number" },
      { name: "req_id",                type: "text",   max: 32 },
      { name: "triggered_by",          type: "text",   max: 20 },   // "operator" | "cron"
      { name: "days",                  type: "number" },
      { name: "runs_deleted",          type: "number" },
      { name: "summaries_deleted",     type: "number" },
      { name: "jobs_deleted",          type: "number" },
      { name: "orphan_queued_failed",  type: "number" },
      { name: "errors_deleted",        type: "number" },
      { name: "idempotency_deleted",   type: "number" },
      { name: "videos_requested",      type: "number" },
      { name: "freed_estimate_mb",     type: "number" },
      { name: "detail",                type: "json",   maxSize: 20000 },
      { name: "errors",                type: "json",   maxSize: 20000 },
      // Snapshot of jobs/videos/errors totals BEFORE this cleanup ran.
      // Kept forever alongside the run so /reports can show historical
      // aggregates even after the source rows were pruned.
      { name: "pre_snapshot",          type: "json",   maxSize: 4000 },
      { name: "created_at",            type: "autodate", onCreate: true },
    ],
    indexes: ["CREATE INDEX idx_cleanup_runs_ts ON cleanup_runs (ts)"],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));
}, (app) => {
  // no down
});
