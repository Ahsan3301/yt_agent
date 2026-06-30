/// <reference path="../pb_data/types.d.ts" />
/**
 * Initial Pocketbase schema for yt-agent.
 *
 * Pocketbase migrations are plain JS run inside its embedded Goja
 * runtime. Auto-applied on boot when present in /pb_migrations/.
 * Idempotent — only creates collections that don't already exist.
 *
 * 13 collections (Firestore had 16 — the 4 subcollections are flattened
 * here because Pocketbase doesn't have a subcollection concept):
 *
 *   1. jobs                 — render queue
 *   2. backends             — registered workers (heartbeats)
 *   3. channels             — dashboard channels (YouTube destinations)
 *   4. youtube_accounts     — connected YouTube OAuth accounts
 *   5. api_keys             — central key store (NIM, Groq, etc.)
 *   6. settings             — global app settings (single "default" doc)
 *   7. runs_index           — completed-run summary index
 *   8. run_summaries        — full per-run details
 *   9. run_logs             — log lines (flat — was a Firestore subcoll)
 *  10. errors               — error/exception captures
 *  11. queue_state          — single "default" doc: paused flag, etc.
 *  12. idempotency          — wake-on-demand dedup keys
 *  13. schedules            — single "default" doc (legacy daily_targets)
 *  14. storage_providers    — pluggable storage backends (see G4)
 *
 * Access rules philosophy:
 *   - Most reads OPEN (the dashboard runs as a single-user setup; no
 *     authn). Tighten when adding multi-user auth.
 *   - Writes restricted to "@request.auth.id != ''" (admin token) so
 *     drive-by writes to your public URL are blocked.
 *   - secret fields (PB_SERVER_TOKEN side) bypass via the dashboard's
 *     service token.
 */
migrate((db) => {
  const dao = new Dao(db);

  function ensure(name, schemaFn) {
    let coll;
    try {
      coll = dao.findCollectionByNameOrId(name);
    } catch (_e) {
      coll = null;
    }
    if (coll) {
      console.log(`[pb-migrate] ${name}: exists, skipping`);
      return coll;
    }
    coll = schemaFn();
    dao.saveCollection(coll);
    console.log(`[pb-migrate] ${name}: created`);
    return coll;
  }

  // Common rule shorthand — server-token writes only, open reads.
  const OPEN_READ = "";              // anyone (incl. unauthed)
  const ADMIN_WRITE = "@request.auth.id != ''";

  // ── jobs ───────────────────────────────────────────────────────
  ensure("jobs", () => new Collection({
    name: "jobs",
    type: "base",
    schema: [
      { name: "status",               type: "text",   options: { max: 32 } },
      { name: "channel",              type: "text",   options: { max: 80 } },
      { name: "dry_run",              type: "bool" },
      { name: "queued_at",            type: "number" },
      { name: "started_at",           type: "number" },
      { name: "finished_at",          type: "number" },
      { name: "percent",              type: "number" },
      { name: "current_step",         type: "text",   options: { max: 64 } },
      { name: "current_step_label",   type: "text",   options: { max: 200 } },
      { name: "video_url",            type: "text",   options: { max: 600 } },
      { name: "public_url",           type: "text",   options: { max: 600 } },
      { name: "error",                type: "text",   options: { max: 2000 } },
      { name: "run_id",               type: "text",   options: { max: 64 } },
      { name: "backend_instance_id",  type: "text",   options: { max: 128 } },
      { name: "backend_url",          type: "text",   options: { max: 400 } },
      { name: "created_by",           type: "text",   options: { max: 64 } },
      { name: "req_id",               type: "text",   options: { max: 32 } },
      // Manual mode passthrough.
      { name: "manual_topic",         type: "text",   options: { max: 1000 } },
      { name: "manual_script",        type: "text",   options: { max: 20000 } },
      { name: "manual_title",         type: "text",   options: { max: 200 } },
      { name: "manual_channel_desc",  type: "text",   options: { max: 500 } },
      { name: "manual_images",        type: "json" },
      // Tri-state flags (true | false | null).
      { name: "web_research",         type: "bool" },
      { name: "real_events",          type: "bool" },
      { name: "language",             type: "text",   options: { max: 5 } },
      { name: "voice_override",       type: "text",   options: { max: 80 } },
      { name: "youtube_account_id",   type: "text",   options: { max: 80 } },
      { name: "source_channel_name",  type: "text",   options: { max: 200 } },
    ],
    indexes: [
      "CREATE INDEX idx_jobs_status_queued ON jobs (status, queued_at)",
      "CREATE INDEX idx_jobs_backend ON jobs (backend_instance_id)",
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── backends ───────────────────────────────────────────────────
  ensure("backends", () => new Collection({
    name: "backends",
    type: "base",
    schema: [
      { name: "instance_id",          type: "text",   options: { max: 128 } },
      { name: "label",                type: "text",   options: { max: 80 } },
      { name: "tier",                 type: "text",   options: { max: 8 } }, // gpu | cpu
      { name: "gpu_name",             type: "text",   options: { max: 128 } },
      { name: "status",               type: "text",   options: { max: 32 } },
      { name: "url",                  type: "text",   options: { max: 400 } },
      { name: "started_at",           type: "number" },
      { name: "last_seen_at",         type: "number" },
      { name: "active_job_id",        type: "text",   options: { max: 64 } },
    ],
    indexes: [
      "CREATE INDEX idx_backends_status_last_seen ON backends (status, last_seen_at)",
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── channels ───────────────────────────────────────────────────
  ensure("channels", () => new Collection({
    name: "channels",
    type: "base",
    schema: [
      { name: "name",                 type: "text",   options: { max: 80 } },
      { name: "niche",                type: "text",   options: { max: 60 } },
      { name: "daily_count",          type: "number", options: { min: 0, max: 10 } },
      { name: "enabled",              type: "bool" },
      { name: "description",          type: "text",   options: { max: 500 } },
      { name: "web_research",         type: "bool" },
      { name: "real_events",          type: "bool" },
      { name: "language",             type: "text",   options: { max: 5 } },
      { name: "voice",                type: "text",   options: { max: 80 } },
      { name: "youtube_account_id",   type: "text",   options: { max: 80 } },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_channels_name ON channels (name)"],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── youtube_accounts ───────────────────────────────────────────
  ensure("youtube_accounts", () => new Collection({
    name: "youtube_accounts",
    type: "base",
    schema: [
      { name: "youtube_channel_id",   type: "text",   options: { max: 80 } },
      { name: "title",                type: "text",   options: { max: 200 } },
      { name: "thumbnail",            type: "text",   options: { max: 400 } },
      { name: "credentials",          type: "text",   options: { max: 4000 } }, // raw JSON, server-only
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── api_keys ───────────────────────────────────────────────────
  // The doc id IS the key name (NVIDIA_NIM_API_KEY, GROQ_API_KEY, etc.)
  // `value` holds the secret. Reads gated by the service token only.
  ensure("api_keys", () => new Collection({
    name: "api_keys",
    type: "base",
    schema: [
      { name: "value",                type: "text",   options: { max: 4000 } },
    ],
    listRule:   ADMIN_WRITE,
    viewRule:   ADMIN_WRITE,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── settings ───────────────────────────────────────────────────
  // Single doc, id = "default". Schemaless JSON blob.
  ensure("settings", () => new Collection({
    name: "settings",
    type: "base",
    schema: [
      { name: "doc",                  type: "json" },
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── runs_index ─────────────────────────────────────────────────
  ensure("runs_index", () => new Collection({
    name: "runs_index",
    type: "base",
    schema: [
      { name: "run_id",               type: "text",   options: { max: 64 } },
      { name: "channel",              type: "text",   options: { max: 80 } },
      { name: "status",               type: "text",   options: { max: 32 } },
      { name: "started_at",           type: "number" },
      { name: "finished_at",          type: "number" },
      { name: "duration_seconds",     type: "number" },
      { name: "title",                type: "text",   options: { max: 200 } },
      { name: "video_url",            type: "text",   options: { max: 600 } },
      { name: "public_url",           type: "text",   options: { max: 600 } },
      { name: "video_storage",        type: "text",   options: { max: 32 } }, // "primary" | "secondary"
      { name: "youtube_video_id",     type: "text",   options: { max: 32 } },
      { name: "thumbnail_url",        type: "text",   options: { max: 600 } },
      { name: "word_count",           type: "number" },
      { name: "error",                type: "text",   options: { max: 2000 } },
    ],
    indexes: [
      "CREATE INDEX idx_runs_index_status_finished ON runs_index (status, finished_at)",
      "CREATE INDEX idx_runs_index_channel_finished ON runs_index (channel, finished_at)",
      "CREATE UNIQUE INDEX idx_runs_index_run_id ON runs_index (run_id)",
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── run_summaries ──────────────────────────────────────────────
  ensure("run_summaries", () => new Collection({
    name: "run_summaries",
    type: "base",
    schema: [
      { name: "run_id",               type: "text",   options: { max: 64 } },
      { name: "doc",                  type: "json" }, // full run summary
    ],
    indexes: ["CREATE UNIQUE INDEX idx_run_summaries_run ON run_summaries (run_id)"],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── run_logs (flat replacement for Firestore runs_index/<id>/logs) ─
  ensure("run_logs", () => new Collection({
    name: "run_logs",
    type: "base",
    schema: [
      { name: "run_id",               type: "text",   options: { max: 64 } },
      { name: "ts",                   type: "number" },
      { name: "level",                type: "text",   options: { max: 16 } },
      { name: "msg",                  type: "text",   options: { max: 4000 } },
      { name: "req_id",               type: "text",   options: { max: 32 } },
    ],
    indexes: [
      "CREATE INDEX idx_run_logs_run_ts ON run_logs (run_id, ts)",
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── errors ─────────────────────────────────────────────────────
  ensure("errors", () => new Collection({
    name: "errors",
    type: "base",
    schema: [
      { name: "ts",                   type: "number" },
      { name: "level",                type: "text",   options: { max: 16 } },
      { name: "kind",                 type: "text",   options: { max: 64 } },
      { name: "title",                type: "text",   options: { max: 200 } },
      { name: "message",              type: "text",   options: { max: 2000 } },
      { name: "stack",                type: "text",   options: { max: 8000 } },
      { name: "run_id",               type: "text",   options: { max: 64 } },
      { name: "req_id",               type: "text",   options: { max: 32 } },
      { name: "worker_label",         type: "text",   options: { max: 80 } },
      { name: "extra",                type: "json" },
    ],
    indexes: [
      "CREATE INDEX idx_errors_ts ON errors (ts)",
      "CREATE INDEX idx_errors_run ON errors (run_id, ts)",
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── queue_state ────────────────────────────────────────────────
  ensure("queue_state", () => new Collection({
    name: "queue_state",
    type: "base",
    schema: [
      { name: "doc",                  type: "json" },
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── idempotency ────────────────────────────────────────────────
  ensure("idempotency", () => new Collection({
    name: "idempotency",
    type: "base",
    schema: [
      { name: "key",                  type: "text",   options: { max: 200 } },
      { name: "job_id",               type: "text",   options: { max: 64 } },
      { name: "ts",                   type: "number" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_idempotency_key ON idempotency (key)"],
    listRule:   ADMIN_WRITE,
    viewRule:   ADMIN_WRITE,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── schedules ──────────────────────────────────────────────────
  ensure("schedules", () => new Collection({
    name: "schedules",
    type: "base",
    schema: [
      { name: "doc",                  type: "json" },
    ],
    listRule:   OPEN_READ,
    viewRule:   OPEN_READ,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  // ── storage_providers (G4) ─────────────────────────────────────
  ensure("storage_providers", () => new Collection({
    name: "storage_providers",
    type: "base",
    schema: [
      { name: "name",                 type: "text",   options: { max: 80 } },
      { name: "kind",                 type: "text",   options: { max: 32 } },
      { name: "endpoint",             type: "text",   options: { max: 300 } },
      { name: "bucket",               type: "text",   options: { max: 100 } },
      { name: "region",               type: "text",   options: { max: 50 } },
      { name: "access_key_id",        type: "text",   options: { max: 200 } },
      { name: "secret_access_key",    type: "text",   options: { max: 2000 } }, // encrypted
      { name: "public_base",          type: "text",   options: { max: 300 } },
      { name: "path_style",           type: "bool" },
      { name: "host",                 type: "text",   options: { max: 200 } },
      { name: "port",                 type: "number" },
      { name: "user",                 type: "text",   options: { max: 100 } },
      { name: "password",             type: "text",   options: { max: 2000 } }, // encrypted
      { name: "base_dir",             type: "text",   options: { max: 200 } },
      { name: "is_primary",           type: "bool" },
      { name: "is_mirror",            type: "bool" },
      { name: "enabled",              type: "bool" },
      { name: "last_health_ok",       type: "bool" },
      { name: "last_health_check",    type: "number" },
      { name: "last_health_message",  type: "text",   options: { max: 300 } },
      { name: "extras",               type: "json" },
    ],
    indexes: [
      "CREATE INDEX idx_storage_primary ON storage_providers (is_primary)",
      "CREATE INDEX idx_storage_mirror ON storage_providers (is_mirror)",
    ],
    // Secrets! Reads gated by service token.
    listRule:   ADMIN_WRITE,
    viewRule:   ADMIN_WRITE,
    createRule: ADMIN_WRITE,
    updateRule: ADMIN_WRITE,
    deleteRule: ADMIN_WRITE,
  }));

  console.log("[pb-migrate] 0001_initial_schema: done");
}, (db) => {
  // Down migration — drop everything. Used by `pocketbase migrate down`.
  const dao = new Dao(db);
  const drop = (name) => {
    try {
      const c = dao.findCollectionByNameOrId(name);
      if (c) dao.deleteCollection(c);
    } catch (_e) { /* not present */ }
  };
  [
    "jobs", "backends", "channels", "youtube_accounts", "api_keys",
    "settings", "runs_index", "run_summaries", "run_logs", "errors",
    "queue_state", "idempotency", "schedules", "storage_providers",
  ].forEach(drop);
});
