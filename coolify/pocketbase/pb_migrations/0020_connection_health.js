/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0020 — connection health tracking.
 *
 * Problem this solves
 * -------------------
 * A YouTube account's refresh token can be revoked at any time (user
 * changes their Google password, revokes app access, Google expires
 * it). Nothing detected that. The first symptom was a render
 * completing after ~20 minutes of GPU time and then failing at the
 * upload step with invalid_grant — and even then, only the operator
 * saw it, in a Discord message.
 *
 * Verified live on 2026-08-01: of 9 connected accounts, 1 had been
 * dead for weeks with no indication anywhere in the product.
 *
 * These fields let the platform check connections proactively and show
 * a customer that their channel needs reconnecting BEFORE they burn a
 * render on it.
 *
 *   health_status      "ok" | "dead" | "error" | "" (never checked)
 *   health_checked_at  unix seconds of the last probe
 *   health_error       short human-readable reason when not ok
 *   health_failures    consecutive failure count, so a single network
 *                      blip doesn't get reported as a dead account
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

  addField("youtube_accounts", { name: "health_status",     type: "text",   max: 16  });
  addField("youtube_accounts", { name: "health_checked_at", type: "number" });
  addField("youtube_accounts", { name: "health_error",      type: "text",   max: 300 });
  addField("youtube_accounts", { name: "health_failures",   type: "number" });

  console.log("[pb-migrate] 0020_connection_health: done");
}, (app) => { /* additive-only; nothing to reverse */ });
