/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0029 — publish-hour auto-tuning bookkeeping.
 *
 * The niche-intel sweep accumulates real top-performer data every day.
 * Once a niche clears bestHours()' evidence floor (60 videos overall,
 * 8 in a given hour bucket) the observation beats the hours that were
 * set by hand on 2026-08-03, so the sweep retunes the channel.
 *
 * `hour_retuned_at` is what stops that from thrashing: a channel may
 * only be moved once per cooldown window, so a niche hovering around
 * the threshold cannot shuffle the schedule every night.
 *
 * Without this field PocketBase silently DROPS the value on write —
 * the update would appear to succeed, the cooldown would read 0
 * forever, and every sweep would be free to move the channel again.
 * That is precisely the failure this field exists to prevent, so it
 * has to be declared.
 *
 *   hour_retuned_at  unix seconds of the last automatic move.
 *                    0/absent = never retuned, eligible immediately.
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

  addField("channels", { name: "hour_retuned_at", type: "number" });

  console.log("[pb-migrate] 0029_schedule_autotune: done");
}, (app) => { /* additive-only */ });
