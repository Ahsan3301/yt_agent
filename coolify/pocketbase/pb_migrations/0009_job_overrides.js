/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0009 — add per-render override fields to the jobs schema.
 *
 * Same class of bug as migration 0007 (CF fields). Channel docs had
 * `privacy` + `tone` set, render-now / scheduled-render dutifully wrote
 *   privacy_override, tone_override
 * onto every queued job, but the jobs collection schema never had
 * columns for them — PB silently dropped both.
 *
 * Result: worker read null → uploader fell to global settings.upload.privacy
 * (currently "public") → every video shipped public regardless of the
 * channel's setting.
 */
migrate((app) => {
  function addField(coll, field) {
    const has = (coll.fields || []).some((f) => f.name === field.name);
    if (has) { console.log(`[pb-migrate] jobs.${field.name}: exists, skipping`); return; }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] jobs.${field.name}: added`);
  }
  let coll;
  try { coll = app.findCollectionByNameOrId("jobs"); }
  catch (_e) { console.log("[pb-migrate] jobs: missing — skipping overrides"); return; }

  addField(coll, { name: "privacy_override", type: "text", max: 12 });
  addField(coll, { name: "tone_override",    type: "text", max: 40 });
}, (app) => {
  // no down
});
