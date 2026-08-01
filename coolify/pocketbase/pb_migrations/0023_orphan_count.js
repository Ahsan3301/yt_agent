/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0023 — orphan_count on jobs.
 *
 * cleanup-stale requeues a job whose worker vanished mid-render, and is
 * supposed to give up the second time so a job that reliably kills its
 * worker cannot cycle forever:
 *
 *     const prev = Number(j.orphan_count || 0);
 *     const action = prev >= 1 ? "failed" : "requeued";
 *
 * `orphan_count` was never declared on the collection, and PocketBase
 * drops undeclared fields silently. So the write succeeded, the value
 * never persisted, every read returned 0, and the branch evaluated to
 * "requeued" every single time. The guard has never once engaged — a
 * job that always orphans would requeue every 15 minutes indefinitely,
 * burning a render slot forever.
 *
 * Same silent-drop class as the fields added in 0022; see
 * 0001_initial_schema.js for the rest of the jobs shape.
 */
migrate((app) => {
  function addField(collName, field) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); }
    catch (_e) {
      console.log(`[pb-migrate] ${collName}: missing — skipping ${field.name}`);
      return;
    }
    if ((coll.fields || []).some((f) => f.name === field.name)) {
      console.log(`[pb-migrate] ${collName}.${field.name}: exists, skipping`);
      return;
    }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collName}.${field.name}: added`);
  }

  // Absent/0 = never orphaned. cleanup-stale fails the job at >= 1.
  addField("jobs", { name: "orphan_count", type: "number" });

  // channels.timezone — IANA zone the channel's run_at_hour is read in.
  //
  // Added by the 2026-07-13 audit to fix run_at_hour being silently
  // UTC-only, but the field was never declared on the live collection.
  // The picker exists in the UI, /api/channels writes the value, and
  // PocketBase drops it — so a customer setting "America/Toronto" gets
  // no effect and no error, and scheduled-render's timezone branch has
  // never once executed. Every channel has been UTC this whole time,
  // which is exactly the bug that audit set out to fix.
  addField("channels", { name: "timezone", type: "text", max: 60 });

  // backends.queue_depth — read by needs-worker to decide whether a
  // live GPU worker is saturated (`qd >= 4` → spawn another). Workers
  // report it, the field was never declared, so it always read 0 and
  // the saturation branch was dead. This one failed safe (it errs
  // toward NOT spawning extra workers), which is why it went unnoticed.
  addField("backends", { name: "queue_depth", type: "number" });

  console.log("[pb-migrate] 0023_orphan_count: done");
}, (app) => { /* additive-only */ });
