/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0015 — worker ownership + job denormalization for the
 * hybrid compute model (free tier = BYO Kaggle, paid tier = shared
 * worker pool).
 *
 * Part of the multi-tenant SaaS refactor (Phase 0).
 *
 *   backends.owner_user_id : nullable — NULL means "shared pool"
 *                             (Oracle side-worker + operator-run
 *                             workers). Non-NULL means "this worker
 *                             was booted by this user's BYO Kaggle
 *                             notebook, only their jobs may claim it".
 *   backends.tier          : "personal" | "shared" — cached for the
 *                             claim filter (avoids a join per claim).
 *                             Existing rows get tier="shared" +
 *                             owner_user_id=NULL by the Phase-1
 *                             migration script.
 *   jobs.owner_user_id     : denormalized copy of job.user_id, kept
 *                             for the claim query's WHERE clause so
 *                             it doesn't need a join to users/plans
 *                             on every heartbeat.
 *
 * The claim route in Phase 2 becomes:
 *   status='queued'
 *   AND (owner_user_id = worker.owner_user_id
 *        OR (worker.tier='shared' AND job.user_plan_allows_shared))
 *
 * Old code that never reads these fields keeps working — all nullable.
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

  addField("backends", { name: "owner_user_id", type: "text", max: 32 });
  addField("backends", { name: "tier_scope",    type: "text", max: 16 });
  addField("jobs",     { name: "owner_user_id", type: "text", max: 32 });

  // Note: we named the new backends field `tier_scope` (not `tier`)
  // because backends.tier ALREADY exists in 0001_initial_schema.js
  // with a different meaning ("gpu"/"dashboard" — describes the
  // worker's compute class, not its ownership scope). Keeping them
  // separate avoids a semantically-loaded rename.

  console.log("[pb-migrate] 0015_worker_ownership: done");
}, (app) => {
  // Additive; leave in place on rollback.
});
