/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0007 — add per-render Cloudflare fields to the jobs collection.
 *
 * Migration 0006 added CF creds to the `channels` collection but the
 * job payload was never widened. render-now / scheduled-render write
 *   cf_source, cf_own_account_id, cf_own_api_token
 * onto every queued job, but PB silently drops fields that aren't in
 * the schema — so `channel_cf.apply_from_job` on the worker side always
 * saw them as None and skipped Cloudflare.
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
  catch (_e) { console.log("[pb-migrate] jobs: missing — skipping CF fields"); return; }

  addField(coll, { name: "cf_source",         type: "text", max: 10 });
  addField(coll, { name: "cf_own_account_id", type: "text", max: 64 });
  addField(coll, { name: "cf_own_api_token",  type: "text", max: 200 });
}, (app) => {
  // no down
});
