/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0032 — inbound forms from the public site.
 *
 * Three collections behind the three things a visitor can send us:
 *
 *   quote_requests  — replaces the pricing table. Prices are no longer
 *                     published, so the ask is "tell us the scale and
 *                     we'll quote it".
 *   contact_messages— general enquiries.
 *   niche_requests  — a visitor whose niche is not one of the built-in
 *                     presets asking for it.
 *
 * All three are admin-rule-only: the public writes through Next.js API
 * routes using the server-side admin token, never straight from the
 * browser. That keeps validation and rate-limiting in one place and
 * means a leaked collection rule cannot be used to spam the table.
 *
 * `status` is a free-text workflow column ("new" | "read" | "closed")
 * so the operator can triage without another migration.
 *
 * Every field a form can write is declared explicitly. PocketBase drops
 * undeclared fields silently — the failure mode that cost a day when
 * runs_index.has_video was written by three code paths and stored by
 * none (see 0031).
 */
migrate((app) => {
  function ensure(name, schemaFn) {
    try {
      const existing = app.findCollectionByNameOrId(name);
      if (existing) { console.log(`[pb-migrate] ${name}: exists, skipping`); return; }
    } catch (_e) { /* create */ }
    app.save(schemaFn());
    console.log(`[pb-migrate] ${name}: created`);
  }

  // NULL = admin-only. The Next.js route is the single write gate.
  const ADMIN_ONLY = null;

  // Columns every inbound form shares. Kept identical across the three
  // so one triage UI can render any of them.
  const COMMON = [
    { name: "name",       type: "text",   max: 120 },
    { name: "email",      type: "text",   max: 320 },
    { name: "message",    type: "text",   max: 4000 },
    { name: "status",     type: "text",   max: 20 },
    { name: "ip",         type: "text",   max: 64 },
    { name: "user_agent", type: "text",   max: 300 },
    { name: "notified",   type: "bool" },   // did the email actually go out
    { name: "created_at", type: "number" },
  ];

  ensure("quote_requests", () => new Collection({
    name: "quote_requests",
    type: "base",
    fields: COMMON.concat([
      { name: "company",       type: "text", max: 160 },
      { name: "channel_url",   type: "text", max: 400 },
      // Free text rather than select: the answers are for a human to
      // read, and a select would need a migration every time we want
      // to reword an option.
      { name: "niche",         type: "text", max: 120 },
      { name: "videos_month",  type: "text", max: 40 },
      { name: "channel_count", type: "text", max: 40 },
    ]),
    indexes: [
      "CREATE INDEX idx_quote_created ON quote_requests (created_at)",
      "CREATE INDEX idx_quote_email   ON quote_requests (email)",
      "CREATE INDEX idx_quote_status  ON quote_requests (status)",
    ],
    listRule: ADMIN_ONLY, viewRule: ADMIN_ONLY, createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY, deleteRule: ADMIN_ONLY,
  }));

  ensure("contact_messages", () => new Collection({
    name: "contact_messages",
    type: "base",
    fields: COMMON.concat([
      { name: "subject", type: "text", max: 200 },
    ]),
    indexes: [
      "CREATE INDEX idx_contact_created ON contact_messages (created_at)",
      "CREATE INDEX idx_contact_email   ON contact_messages (email)",
      "CREATE INDEX idx_contact_status  ON contact_messages (status)",
    ],
    listRule: ADMIN_ONLY, viewRule: ADMIN_ONLY, createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY, deleteRule: ADMIN_ONLY,
  }));

  ensure("niche_requests", () => new Collection({
    name: "niche_requests",
    type: "base",
    fields: COMMON.concat([
      { name: "niche_name",  type: "text", max: 120 },
      { name: "examples",    type: "text", max: 800 },
      { name: "language",    type: "text", max: 80 },
    ]),
    indexes: [
      "CREATE INDEX idx_niche_req_created ON niche_requests (created_at)",
      "CREATE INDEX idx_niche_req_email   ON niche_requests (email)",
      "CREATE INDEX idx_niche_req_status  ON niche_requests (status)",
    ],
    listRule: ADMIN_ONLY, viewRule: ADMIN_ONLY, createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY, deleteRule: ADMIN_ONLY,
  }));

  console.log("[pb-migrate] 0032_inbound_forms: done");
}, (app) => {
  const drop = (name) => {
    try { const c = app.findCollectionByNameOrId(name); if (c) app.delete(c); }
    catch (_e) { /* already gone */ }
  };
  drop("quote_requests");
  drop("contact_messages");
  drop("niche_requests");
});
