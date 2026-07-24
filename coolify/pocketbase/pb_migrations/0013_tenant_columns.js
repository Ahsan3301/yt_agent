/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0013 — add nullable, indexed `user_id` to every tenant
 * collection.
 *
 * Part of the multi-tenant SaaS refactor (Phase 0). Additive only —
 * nullable = old code that never sets user_id keeps working. The
 * Phase-1 migration script backfills user_id="u_founder" on every
 * existing row before Phase 2 (which starts filtering on it) ships.
 *
 * Skips backends/queue_state/idempotency/cleanup_runs from the strict
 * "per tenant" model — those are per-worker-pool or global — but adds
 * user_id anyway so we can OPT them into tenancy later without another
 * migration (e.g. per-user cleanup_runs when analytics needs it).
 * Same reason we add it to `settings`: the composite-key naming
 * scheme (`settings/{user_id}__default`) is the primary key path, but
 * having a user_id column lets us query "all settings for user X".
 */
migrate((app) => {
  function addField(collName, field) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); }
    catch (_e) { console.log(`[pb-migrate] ${collName}: missing — skipping ${field.name}`); return; }
    const has = (coll.fields || []).some((f) => f.name === field.name);
    if (has) { console.log(`[pb-migrate] ${collName}.${field.name}: exists, skipping`); return; }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collName}.${field.name}: added`);
  }

  function addIndex(collName, sql) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); } catch (_e) { return; }
    const has = (coll.indexes || []).some((s) => String(s).includes(`idx_${collName}_user_id`));
    if (has) { console.log(`[pb-migrate] ${collName}: user_id index exists, skipping`); return; }
    coll.indexes = [...(coll.indexes || []), sql];
    app.save(coll);
    console.log(`[pb-migrate] ${collName}: user_id index added`);
  }

  const TENANT = [
    "channels", "jobs", "runs_index", "run_summaries", "run_logs",
    "errors", "youtube_accounts", "storage_providers", "schedules",
    "api_keys", "backends", "queue_state", "idempotency",
    "cleanup_runs", "settings",
  ];
  for (const t of TENANT) {
    addField(t, { name: "user_id", type: "text", max: 32 });
    addIndex(t, `CREATE INDEX idx_${t}_user_id ON ${t} (user_id)`);
  }

  console.log("[pb-migrate] 0013_tenant_columns: done");
}, (app) => {
  // Down: leave the columns in place (they're nullable, harmless).
  // Reverting the additive migration would require dropping indexes
  // AND fields per collection — cleaner to leave them since they
  // don't affect old-code behaviour.
});
