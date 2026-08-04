/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0031 — declare runs_index.has_video and runs_index.ok.
 *
 * Both fields have been WRITTEN by the workers since they were added
 * (backend/jobs.py index_entry, coolify/side_worker/entrypoint.py) but
 * were never declared on the collection. PocketBase silently drops
 * fields it does not know about, so every write of them has been a
 * no-op. Measured on the live install: 23 runs_index rows, `has_video`
 * null on all 23, while the bucket held 57 videos.
 *
 * Two things were broken by that, both silently:
 *
 * 1. RETENTION NEVER DELETED A SINGLE VIDEO. The sweep in
 *    web/app/api/maintenance/cleanup/route.ts reads
 *      if (fin == null || fin >= cutoff || !d.has_video) return;
 *    With has_video undefined on every row, that guard returns early
 *    every time. Storage could only ever grow. The user ran cleanup,
 *    it reported success, and freed nothing — which is exactly what a
 *    silently-dropped field looks like from the outside.
 *
 * 2. PREMISE DEDUP SEEDING DID NOTHING. researcher._seed_from_db skips
 *    any row where `ok` is falsy, so with `ok` undefined it discarded
 *    every row and returned an empty set. The cross-worker guard against
 *    re-picking a premise already published has therefore never run.
 *
 * Also backfills has_video from the video_url the rows DO carry, so
 * retention starts working on the existing 57 files rather than only on
 * renders made from here on. `ok` is backfilled from the absence of an
 * error string, which is the same test the writers apply.
 */
migrate((app) => {
  function addField(collName, field) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); }
    catch (_e) {
      console.log(`[pb-migrate] ${collName}: missing — skipping ${field.name}`);
      return null;
    }
    if ((coll.fields || []).some((f) => f.name === field.name)) {
      console.log(`[pb-migrate] ${collName}.${field.name}: exists, skipping`);
      return coll;
    }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collName}.${field.name}: added`);
    return coll;
  }

  addField("runs_index", { name: "has_video", type: "bool" });
  addField("runs_index", { name: "ok",        type: "bool" });

  // Backfill. Without this, retention would still ignore every video
  // that already exists — the fix would only apply to future renders
  // and the 12 GB already on disk would sit there forever.
  let n = 0;
  try {
    const rows = app.findRecordsByFilter("runs_index", "id != ''", "-finished_at", 500, 0);
    for (const r of rows) {
      let touched = false;
      if (r.get("has_video") === null || r.get("has_video") === undefined) {
        const url = String(r.get("video_url") || r.get("public_url") || "");
        r.set("has_video", url.length > 0);
        touched = true;
      }
      if (r.get("ok") === null || r.get("ok") === undefined) {
        r.set("ok", String(r.get("error") || "").length === 0);
        touched = true;
      }
      if (touched) { app.save(r); n += 1; }
    }
  } catch (e) {
    console.log(`[pb-migrate] 0031 backfill skipped: ${e}`);
  }
  console.log(`[pb-migrate] 0031: backfilled ${n} row(s)`);

  console.log("[pb-migrate] 0031_runs_index_has_video: done");
}, (app) => { /* additive-only */ });
