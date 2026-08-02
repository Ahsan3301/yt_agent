/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0024 — stall probe state on jobs.
 *
 * cleanup-stale needs to tell "wedged" apart from "slow". Log silence
 * alone cannot do it: measured on a live render, the "Editing video"
 * stage went 14 minutes without writing a line while the job was
 * demonstrably progressing (75% -> 82%), and renders on the CPU
 * side-worker run for hours. A silence-only threshold generous enough
 * not to kill those is too generous to catch anything.
 *
 * So the probe records what progress looked like last tick, and a job
 * is only judged stuck when BOTH signals agree: percent has not moved
 * AND nothing has been logged, for the whole window.
 *
 *   stall_probe_percent  percent observed at the last sweep
 *   stall_probe_at       unix seconds of that observation
 *
 * Both absent = never probed; the first sweep records them and judges
 * nothing, so a job can never be failed on its first sighting.
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

  addField("jobs", { name: "stall_probe_percent", type: "number" });
  addField("jobs", { name: "stall_probe_at",      type: "number" });

  console.log("[pb-migrate] 0024_stall_probe: done");
}, (app) => { /* additive-only */ });
