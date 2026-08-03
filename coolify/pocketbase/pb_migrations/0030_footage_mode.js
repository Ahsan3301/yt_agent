/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0030 — per-channel footage mode.
 *
 * Real motion footage (generated clips + public-domain archive video)
 * is opt-in PER CHANNEL rather than a global switch, because the
 * providers behind it are rate-limited and uneven: Agnes has generation
 * quota, and the Internet Archive only sometimes has on-topic footage.
 * Enabling it everywhere at once would spend that budget across
 * channels the operator has not evaluated yet, and would make a
 * regression impossible to attribute.
 *
 *   stills    AI images only — no generated clips, no archive footage.
 *   standard  DEFAULT and the pre-existing behaviour: generated clips
 *             for the opening shots, stills for the rest.
 *   motion    standard PLUS real archive footage, over more shots.
 *
 * Blank/absent reads as "standard" in modules/shotfinder, so every
 * existing channel renders exactly as it did before this field existed.
 * That is deliberate: adding the column must change nothing until the
 * operator chooses a channel to try it on.
 *
 * Declared on BOTH collections. `channels` is where the operator sets
 * it; `jobs` carries it to the worker. A field PocketBase does not know
 * about is silently dropped on write, so omitting the jobs column would
 * mean the setting reached the queue and evaporated.
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

  addField("channels", { name: "footage_mode", type: "text", max: 16 });
  addField("jobs",     { name: "footage_mode", type: "text", max: 16 });

  console.log("[pb-migrate] 0030_footage_mode: done");
}, (app) => { /* additive-only */ });
