/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0021 — manual subscription tracking.
 *
 * Payments are handled outside the product (bank transfer / local
 * methods — Stripe isn't available in Pakistan). That means no
 * webhook ever tells the platform a subscription lapsed.
 *
 * Until now a plan assignment had no time dimension at all: an
 * operator upgrading someone to Pro after a payment made them Pro
 * permanently. Fine with a card on file and a billing provider
 * revoking access; a straight revenue leak when the operator is the
 * billing system.
 *
 *   plan_expires_at   unix seconds; 0/absent = no expiry (free,
 *                     founder, comped accounts)
 *   plan_note         what was actually agreed — "paid PKR 8000,
 *                     bank transfer, 2026-08-01". The operator IS the
 *                     billing system here, so this is the only record
 *                     of why someone is on a plan.
 *   plan_assigned_at  when the current plan was set
 *   plan_assigned_by  which operator set it
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

  addField("app_users", { name: "plan_expires_at",  type: "number" });
  addField("app_users", { name: "plan_note",        type: "text", max: 300 });
  addField("app_users", { name: "plan_assigned_at", type: "number" });
  addField("app_users", { name: "plan_assigned_by", type: "text", max: 32 });

  console.log("[pb-migrate] 0021_manual_billing: done");
}, (app) => { /* additive-only */ });
