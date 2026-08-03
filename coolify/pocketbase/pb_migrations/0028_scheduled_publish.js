/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0028 — scheduled publish target on jobs.
 *
 * Until now `run_at_hour` meant "start rendering at this hour", so a
 * video went live whenever its encode happened to finish: ~20 minutes
 * later on a GPU worker, several HOURS later on the CPU one. The moment
 * a video reached the audience was an accident of queue depth and
 * hardware, and essentially never the hour that audience is watching.
 *
 * `publish_at` carries the intended release moment from the scheduler
 * through to the uploader, which hands it to YouTube as `publishAt`.
 * YouTube then holds the video and releases it itself at that instant.
 * Render early, publish exactly on time — a slow render no longer
 * misses the window, it just sits ready.
 *
 *   publish_at   unix seconds. 0/absent = publish as soon as the render
 *                lands (the previous behaviour, kept for manual runs and
 *                the legacy daily_targets path).
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

  addField("jobs", { name: "publish_at", type: "number" });

  console.log("[pb-migrate] 0028_scheduled_publish: done");
}, (app) => { /* additive-only */ });
