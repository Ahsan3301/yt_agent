/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0008 — per-channel LLM provider priority.
 *
 * channels.llm_priority (text): comma-separated ordered list of
 *   provider names from {nim, groq, openrouter}. Empty = use default.
 *
 * jobs.llm_priority (text): same, written by render-now / scheduled-
 *   render and consumed by channel_llm.apply_from_job on the worker.
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
  addField("channels", { name: "llm_priority", type: "text", max: 60 });
  addField("jobs",     { name: "llm_priority", type: "text", max: 60 });
}, (app) => {});
