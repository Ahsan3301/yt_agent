/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0017 — flip every tenant collection's listRule/viewRule
 * from OPEN ("") to SUPERUSER_ONLY (null).
 *
 * Before: the client-side PocketBase SDK could hit
 * /api/collections/{name}/records directly and read every tenant's
 * data (only createRule/updateRule/deleteRule were closed).
 *
 * After: only the Next.js dashboard's admin JWT can read these
 * collections. The client never talks to PB directly — every read
 * goes through a /api/* route that requireTenant()-scopes the query.
 *
 * SAFE because no client code uses the PocketBase SDK — verified
 * by grep across web/app + web/components. useRealtimeCollection.ts
 * has PB SSE code but is imported nowhere (deleted in the same
 * commit that runs this migration).
 *
 * Rollback: down() flips rules back to OPEN so the client could
 * re-subscribe if we ever add a client-side PB SDK usage. Safe to
 * roll back at any time — server-side admin reads are unaffected
 * by rule changes (superuser bypasses).
 */
migrate((app) => {
  const TENANT = [
    "channels", "jobs", "runs_index", "run_summaries", "run_logs",
    "errors", "youtube_accounts", "storage_providers", "schedules",
    "api_keys", "backends", "queue_state", "idempotency",
    "cleanup_runs", "settings",
    // SaaS-refactor collections — already SUPERUSER_ONLY, no-op here.
    "app_users", "plans", "landing_content", "audit_log",
  ];
  for (const name of TENANT) {
    let coll;
    try { coll = app.findCollectionByNameOrId(name); }
    catch (_e) { console.log(`[pb-migrate] ${name}: missing, skipping`); continue; }
    // Flip every non-write rule. Write rules were already SUPERUSER_ONLY.
    coll.listRule = null;
    coll.viewRule = null;
    // createRule/updateRule/deleteRule already null on every collection
    // per the original migrations; belt-and-suspenders here.
    coll.createRule = null;
    coll.updateRule = null;
    coll.deleteRule = null;
    app.save(coll);
    console.log(`[pb-migrate] ${name}: rules locked to SUPERUSER_ONLY`);
  }
  console.log("[pb-migrate] 0017_lock_rules: done");
}, (app) => {
  // Rollback: restore OPEN read rules (empty string = anyone).
  const TENANT = [
    "channels", "jobs", "runs_index", "run_summaries", "run_logs",
    "errors", "youtube_accounts", "storage_providers", "schedules",
    "backends", "queue_state", "schedules", "cleanup_runs", "settings",
    // These collections were SUPERUSER_ONLY from creation — leave them.
  ];
  for (const name of TENANT) {
    let coll;
    try { coll = app.findCollectionByNameOrId(name); } catch (_e) { continue; }
    coll.listRule = "";
    coll.viewRule = "";
    app.save(coll);
  }
});
