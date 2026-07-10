/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0005 — add pre_snapshot field to cleanup_runs.
 *
 * Migration 0004 already created cleanup_runs; adding a new field
 * needs its own migration file so it re-runs on existing PB
 * installs.
 */
migrate((app) => {
  let coll;
  try {
    coll = app.findCollectionByNameOrId("cleanup_runs");
  } catch (_e) {
    console.log("[pb-migrate] cleanup_runs missing — skipping pre_snapshot add");
    return;
  }
  const has = (coll.fields || []).some((f) => f.name === "pre_snapshot");
  if (has) {
    console.log("[pb-migrate] cleanup_runs.pre_snapshot: exists, skipping");
    return;
  }
  coll.fields.add(new Field({ name: "pre_snapshot", type: "json", maxSize: 4000 }));
  app.save(coll);
  console.log("[pb-migrate] cleanup_runs.pre_snapshot: added");
}, (app) => {
  // no down
});
