/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0019 — dashboard-editable platform configuration.
 *
 * Problem this solves
 * -------------------
 * Operational settings lived only in Coolify's environment store, so
 * changing any of them meant editing env vars and redeploying — a
 * multi-minute round trip for something like swapping a backup bucket
 * or rotating an OAuth client. The Python workers already avoid this
 * (backend/keys_sync.py pulls the `api_keys` collection into os.environ
 * before every job), but the Next.js side read process.env directly.
 *
 * This collection is the Next.js equivalent: values here override the
 * corresponding environment variable at runtime, so edits take effect
 * within a second and survive redeploys.
 *
 * Deliberately NOT everything
 * ---------------------------
 * Three things must stay in the environment and are rejected by the
 * API rather than silently ignored:
 *
 *   1. Bootstrap credentials — POCKETBASE_ADMIN_*, PB_URL_INTERNAL,
 *      DB_BACKEND. They are how the app reaches this table; storing
 *      them in it is circular.
 *   2. SESSION_SECRET — it authenticates the very cookie that
 *      authorises reading this table.
 *   3. NEXT_PUBLIC_* — Next.js inlines these into the client bundle
 *      at build time. A database value cannot change a string that is
 *      already compiled into the JavaScript users downloaded.
 *
 * `secret: true` rows are never returned in full by the read API —
 * only a masked preview — so the config page can show that a value is
 * set without re-displaying it.
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

  // Admin-token only — the Next.js API is the single gate, matching
  // every other tenant collection.
  const ADMIN_ONLY = null;

  ensure("platform_config", () => new Collection({
    name: "platform_config",
    type: "base",
    fields: [
      // Env-var-style key, e.g. BACKUP_S3_BUCKET. Unique.
      { name: "key",        type: "text",   max: 100, required: true },
      { name: "value",      type: "text",   max: 4000 },
      // Grouping for the settings UI: backup | oauth | storage |
      // integrations | limits | general
      { name: "category",   type: "text",   max: 40 },
      // Shown under the field in the config page.
      { name: "label",      type: "text",   max: 160 },
      { name: "help",       type: "text",   max: 500 },
      // Masked on read and write-only in the UI.
      { name: "secret",     type: "bool" },
      { name: "updated_by", type: "text",   max: 32 },
      { name: "updated_at", type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_platform_config_key ON platform_config (key)",
      "CREATE INDEX idx_platform_config_cat ON platform_config (category)",
    ],
    listRule:   ADMIN_ONLY,
    viewRule:   ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
  }));

  console.log("[pb-migrate] 0019_platform_config: done");
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("platform_config");
    if (c) app.delete(c);
  } catch (_e) { /* not present */ }
});
