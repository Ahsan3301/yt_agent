/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0018 — CMS-editable roadmap + referral tracking.
 *
 * Adds two collections:
 *
 *   roadmap_items       — public roadmap entries editable at
 *                         /superadmin/roadmap. Superadmin-only rules;
 *                         Next.js /roadmap SSR reads via server-side
 *                         admin token (bypasses the rules).
 *
 *   referrals           — per-user invite code (one row per referrer).
 *                         Auto-generated on signup by /api/auth/register.
 *
 *   referral_signups    — one row per join attributed to a referrer.
 *                         Status "joined" when referred user completes
 *                         approval; drives the 5-friend unlock UX.
 *
 *   demo_waitlist       — Batch C uses this. Predeclared here to keep
 *                         migrations sequential — one migration per
 *                         schema batch is easier to reason about than
 *                         one per collection.
 */
migrate((app) => {
  function ensure(name, schemaFn) {
    try {
      const existing = app.findCollectionByNameOrId(name);
      if (existing) { console.log(`[pb-migrate] ${name}: exists, skipping`); return; }
    } catch (_e) { /* create */ }
    const coll = schemaFn();
    app.save(coll);
    console.log(`[pb-migrate] ${name}: created`);
  }

  // NULL = admin-only for all rules — the Next dashboard is the single gate.
  const ADMIN_ONLY = null;

  // ── roadmap_items ─────────────────────────────────────────────
  // status: "live" | "next" | "planned" | "changelog"
  // section: for changelog entries — free-text label like "August 2026"
  //          so the /roadmap page can group them without a second table.
  // sort_order: lower = higher on the page. Ties break by created.
  ensure("roadmap_items", () => new Collection({
    name: "roadmap_items",
    type: "base",
    fields: [
      { name: "status",      type: "text",   max: 16 },
      { name: "title",       type: "text",   max: 160 },
      { name: "body",        type: "text",   max: 600 },
      { name: "tag",         type: "text",   max: 40 },
      { name: "section",     type: "text",   max: 40 },
      { name: "sort_order",  type: "number" },
      { name: "created",     type: "number" },
      { name: "updated",     type: "number" },
    ],
    indexes: [
      "CREATE INDEX idx_roadmap_status_sort ON roadmap_items (status, sort_order)",
      "CREATE INDEX idx_roadmap_section ON roadmap_items (section, sort_order)",
    ],
    listRule:   ADMIN_ONLY,
    viewRule:   ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
  }));

  // ── referrals ─────────────────────────────────────────────────
  // Composite key user_id (unique) so `_pb_id(user_id, "referral")`
  // gives a stable row per user. code is short-lowercase-hex,
  // unique-indexed for the /r/:code short-link lookup.
  ensure("referrals", () => new Collection({
    name: "referrals",
    type: "base",
    fields: [
      { name: "user_id",     type: "text",   max: 32 },
      { name: "code",        type: "text",   max: 24 },
      { name: "created_at",  type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_referrals_user ON referrals (user_id)",
      "CREATE UNIQUE INDEX idx_referrals_code ON referrals (code)",
    ],
    listRule:   ADMIN_ONLY,
    viewRule:   ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
  }));

  // ── referral_signups ──────────────────────────────────────────
  // One row per attributed signup. referrer_user_id points to the
  // referrer's app_users id. referred_user_id fills once the referred
  // user completes signup (nullable while status="pending").
  // status: "pending" (referral link visited, no signup yet) |
  //         "signed_up" (referred user completed signup, awaiting admin approve) |
  //         "joined" (referred user became active — counts toward unlock).
  ensure("referral_signups", () => new Collection({
    name: "referral_signups",
    type: "base",
    fields: [
      { name: "referrer_user_id", type: "text",   max: 32 },
      { name: "referred_user_id", type: "text",   max: 32 },
      { name: "referred_email",   type: "text",   max: 320 },
      { name: "status",           type: "text",   max: 16 },
      { name: "created_at",       type: "number" },
      { name: "joined_at",        type: "number" },
    ],
    indexes: [
      "CREATE INDEX idx_ref_signup_referrer ON referral_signups (referrer_user_id, status)",
      "CREATE INDEX idx_ref_signup_referred ON referral_signups (referred_user_id)",
    ],
    listRule:   ADMIN_ONLY,
    viewRule:   ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
  }));

  // ── demo_waitlist ─────────────────────────────────────────────
  // Simple contact-capture for the /demo webinar page.
  ensure("demo_waitlist", () => new Collection({
    name: "demo_waitlist",
    type: "base",
    fields: [
      { name: "email",        type: "text",   max: 320 },
      { name: "first_name",   type: "text",   max: 80 },
      { name: "channel_url",  type: "text",   max: 400 },
      { name: "ip",           type: "text",   max: 64 },
      { name: "created_at",   type: "number" },
    ],
    indexes: [
      "CREATE INDEX idx_demo_wl_created ON demo_waitlist (created_at)",
      "CREATE INDEX idx_demo_wl_email   ON demo_waitlist (email)",
    ],
    listRule:   ADMIN_ONLY,
    viewRule:   ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
  }));

  console.log("[pb-migrate] 0018_roadmap_and_referrals: done");
}, (app) => {
  const drop = (name) => {
    try { const c = app.findCollectionByNameOrId(name); if (c) app.delete(c); }
    catch (_e) { /* not present */ }
  };
  ["roadmap_items", "referrals", "referral_signups", "demo_waitlist"].forEach(drop);
});
