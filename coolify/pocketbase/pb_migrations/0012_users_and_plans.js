/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0012 — SaaS foundation collections: users, plans,
 * landing_content, audit_log.
 *
 * Part of the multi-tenant SaaS refactor. Phase 0 = schema only —
 * no reader/writer code touches these yet. Old system keeps working.
 *
 * See plan file:
 *   ~/.claude/plans/so-other-than-cloudflare-wise-ullman.md
 *
 * All collections are SUPERUSER_ONLY on every rule — the Next.js
 * dashboard is the single gate for access, matching the design that
 * keeps the client PB SDK from ever reading tenant data directly.
 *
 * Passwords use argon2 (stored as password_hash + password_salt) —
 * NOT PB's native `_pb_users_auth` type, because we want to keep our
 * own HMAC cookie contract and avoid rewriting every existing route.
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

  const SUPERUSER_ONLY = null;

  // ── app_users ─────────────────────────────────────────────────
  // NOT named `users` — that name collides with PocketBase's built-in
  // native auth collection (type=auth). We use our own base collection
  // + argon2 hashing so we can keep the HMAC cookie contract without
  // rewriting every existing API route to speak PB auth tokens.
  //
  // The founding user is bootstrapped with id="u_founder" by the
  // migrate_to_multitenant.py script in Phase 1. Fixed ID (not random)
  // so re-running the script is idempotent.
  ensure("app_users", () => new Collection({
    name: "app_users",
    type: "base",
    fields: [
      { name: "email",          type: "text",   max: 320 },
      { name: "password_hash",  type: "text",   max: 512 },
      { name: "password_salt",  type: "text",   max: 128 },
      // Enum stored as free text (PB has no enum type). Route handlers
      // validate. Values: "user", "admin", "superadmin".
      { name: "role",           type: "text",   max: 16 },
      // "pending" (default at signup), "active" (after admin approve),
      // "suspended" (admin can pause without deleting).
      { name: "status",         type: "text",   max: 16 },
      { name: "plan_id",        type: "text",   max: 32 },
      // Optional per-user Kaggle credentials for BYO free-tier workers.
      // Encrypted at rest via the same storage-crypto helper used by
      // storage_providers.secret_access_key (added when the register
      // route is wired in Phase 1).
      { name: "kaggle_username",type: "text",   max: 80 },
      { name: "kaggle_key",     type: "text",   max: 200 },
      { name: "approved_by",    type: "text",   max: 32 },
      { name: "approved_at",    type: "number" },
      { name: "created_at",     type: "number" },
      { name: "last_login_at",  type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_users_email ON users (email)",
      "CREATE INDEX idx_users_status_role ON users (status, role)",
    ],
    listRule:   SUPERUSER_ONLY,
    viewRule:   SUPERUSER_ONLY,
    createRule: SUPERUSER_ONLY,
    updateRule: SUPERUSER_ONLY,
    deleteRule: SUPERUSER_ONLY,
  }));

  // ── plans ─────────────────────────────────────────────────────
  // Founding user gets "founder" plan (unlimited); Phase-5 admin UI
  // manages the rest. price_monthly/yearly are in cents (integer) to
  // avoid float rounding. Null max_* = unlimited.
  ensure("plans", () => new Collection({
    name: "plans",
    type: "base",
    fields: [
      { name: "slug",                    type: "text",   max: 32 },
      { name: "name",                    type: "text",   max: 80 },
      { name: "price_monthly",           type: "number" },
      { name: "price_yearly",            type: "number" },
      { name: "max_channels",            type: "number" },
      { name: "max_renders_month",       type: "number" },
      { name: "shared_worker_access",    type: "bool" },
      { name: "features",                type: "json",   maxSize: 20000 },
      { name: "active",                  type: "bool" },
      { name: "sort_order",              type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_plans_slug ON plans (slug)",
    ],
    listRule:   SUPERUSER_ONLY,
    viewRule:   SUPERUSER_ONLY,
    createRule: SUPERUSER_ONLY,
    updateRule: SUPERUSER_ONLY,
    deleteRule: SUPERUSER_ONLY,
  }));

  // ── landing_content ───────────────────────────────────────────
  // Single-row singleton (id="landing"). Superadmin edits via
  // /superadmin/content in Phase 4. Marketing page SSRs from here
  // with Next revalidate=60 so PB isn't hit on every page load.
  ensure("landing_content", () => new Collection({
    name: "landing_content",
    type: "base",
    fields: [
      { name: "hero_title",     type: "text",   max: 200 },
      { name: "hero_sub",       type: "text",   max: 500 },
      { name: "hero_cta_text",  type: "text",   max: 60 },
      { name: "hero_cta_href",  type: "text",   max: 200 },
      { name: "features",       type: "json",   maxSize: 50000 },
      { name: "pricing_tiers",  type: "json",   maxSize: 50000 },
      { name: "footer_links",   type: "json",   maxSize: 20000 },
      { name: "updated_by",     type: "text",   max: 32 },
      { name: "updated_at",     type: "number" },
    ],
    listRule:   SUPERUSER_ONLY,
    viewRule:   SUPERUSER_ONLY,
    createRule: SUPERUSER_ONLY,
    updateRule: SUPERUSER_ONLY,
    deleteRule: SUPERUSER_ONLY,
  }));

  // ── audit_log ─────────────────────────────────────────────────
  // Append-only. Every superadmin action, every impersonated write,
  // every plan change, every user approval/rejection lands here.
  // Never surfaced to non-admins.
  ensure("audit_log", () => new Collection({
    name: "audit_log",
    type: "base",
    fields: [
      { name: "ts",                    type: "number" },
      { name: "actor_user_id",         type: "text",   max: 32 },
      { name: "impersonated_user_id",  type: "text",   max: 32 },
      { name: "action",                type: "text",   max: 64 },
      { name: "target_type",           type: "text",   max: 32 },
      { name: "target_id",             type: "text",   max: 64 },
      { name: "meta",                  type: "json",   maxSize: 50000 },
      { name: "ip",                    type: "text",   max: 64 },
      { name: "user_agent",            type: "text",   max: 400 },
    ],
    indexes: [
      "CREATE INDEX idx_audit_ts ON audit_log (ts)",
      "CREATE INDEX idx_audit_actor ON audit_log (actor_user_id, ts)",
      "CREATE INDEX idx_audit_target ON audit_log (target_type, target_id, ts)",
    ],
    listRule:   SUPERUSER_ONLY,
    viewRule:   SUPERUSER_ONLY,
    createRule: SUPERUSER_ONLY,
    updateRule: SUPERUSER_ONLY,
    deleteRule: SUPERUSER_ONLY,
  }));

  console.log("[pb-migrate] 0012_users_and_plans: done");
}, (app) => {
  const drop = (name) => {
    try { const c = app.findCollectionByNameOrId(name); if (c) app.delete(c); }
    catch (_e) { /* not present */ }
  };
  ["app_users", "plans", "landing_content", "audit_log"].forEach(drop);
});
