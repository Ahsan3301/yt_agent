/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0011 — per-channel Agnes AI image provider.
 *
 * Agnes AI (agnes-ai.com) is a free OpenAI-compatible image API. Each
 * channel opts in independently with its OWN key, so channels that
 * leave it off never send prompts to Agnes.
 *
 *   channels.agnes_source   : "off" | "own"
 *   channels.agnes_api_key  : the channel's own sk-... key (write-only;
 *                             stripped from the public API view)
 *   jobs.agnes_source       : propagated per render
 *   jobs.agnes_own_api_key  : propagated per render (backend/channel_agnes
 *                             exports it as AGNES_API_KEY for the pipeline)
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
  addField("channels", { name: "agnes_source",      type: "text", max: 10 });
  addField("channels", { name: "agnes_api_key",     type: "text", max: 200 });
  addField("jobs",     { name: "agnes_source",      type: "text", max: 10 });
  addField("jobs",     { name: "agnes_own_api_key", type: "text", max: 200 });
}, (app) => {});
