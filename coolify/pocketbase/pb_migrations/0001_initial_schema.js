/// <reference path="../pb_data/types.d.ts" />
/**
 * Initial Pocketbase schema for yt-agent. (v0.23+ API)
 *
 * Pocketbase migrations are JS run inside Goja. Auto-applied on boot
 * when present in /pb_migrations/. Idempotent — collections that
 * already exist are skipped.
 *
 * Compared to the legacy v0.22 Dao API, v0.23+ uses:
 *   migrate((app) => { ... })            // app, not db
 *   new Collection({ fields: [...] })    // fields, not schema
 *   app.save(coll)                       // not dao.saveCollection()
 *   app.findCollectionByNameOrId(name)   // not dao.findCollection...()
 *   app.delete(coll)                     // not dao.deleteCollection()
 *
 * Field shape changed too — options are flattened:
 *   v0.22: { name, type: "text", options: { max: 32 } }
 *   v0.23: { name, type: "text", max: 32 }
 *
 * 14 collections (Firestore had 16 — runs_index/<id>/logs subcollection
 * flattened to run_logs with a run_id column).
 */
migrate((app) => {
  function ensure(name, schemaFn) {
    try {
      const existing = app.findCollectionByNameOrId(name);
      if (existing) {
        console.log(`[pb-migrate] ${name}: exists, skipping`);
        return;
      }
    } catch (_e) {
      // not found → create
    }
    const coll = schemaFn();
    app.save(coll);
    console.log(`[pb-migrate] ${name}: created`);
  }

  // Access rule shortcuts.
  // - "" → anyone (incl. unauthed; matches the existing Firestore "open read")
  // - null → nobody from client; server (superuser) only
  const OPEN = "";
  const SUPERUSER_ONLY = null;

  // ── jobs ───────────────────────────────────────────────────────
  ensure("jobs", () => new Collection({
    name: "jobs",
    type: "base",
    fields: [
      { name: "status",               type: "text",   max: 32 },
      { name: "channel",              type: "text",   max: 80 },
      { name: "dry_run",              type: "bool" },
      { name: "queued_at",            type: "number" },
      { name: "started_at",           type: "number" },
      { name: "finished_at",          type: "number" },
      { name: "percent",              type: "number" },
      { name: "current_step",         type: "text",   max: 64 },
      { name: "current_step_label",   type: "text",   max: 200 },
      { name: "video_url",            type: "text",   max: 600 },
      { name: "public_url",           type: "text",   max: 600 },
      { name: "error",                type: "text",   max: 2000 },
      { name: "run_id",               type: "text",   max: 64 },
      { name: "backend_instance_id",  type: "text",   max: 128 },
      { name: "backend_url",          type: "text",   max: 400 },
      { name: "created_by",           type: "text",   max: 64 },
      { name: "req_id",               type: "text",   max: 32 },
      { name: "manual_topic",         type: "text",   max: 1000 },
      { name: "manual_script",        type: "text",   max: 20000 },
      { name: "manual_title",         type: "text",   max: 200 },
      { name: "manual_channel_desc",  type: "text",   max: 500 },
      { name: "manual_images",        type: "json",   maxSize: 200000 },
      { name: "web_research",         type: "bool" },
      { name: "real_events",          type: "bool" },
      { name: "language",             type: "text",   max: 5 },
      { name: "voice_override",       type: "text",   max: 80 },
      { name: "youtube_account_id",   type: "text",   max: 80 },
      { name: "source_channel_name",  type: "text",   max: 200 },
    ],
    indexes: [
      "CREATE INDEX idx_jobs_status_queued ON jobs (status, queued_at)",
      "CREATE INDEX idx_jobs_backend ON jobs (backend_instance_id)",
    ],
    listRule:   OPEN,
    viewRule:   OPEN,
    createRule: SUPERUSER_ONLY,
    updateRule: SUPERUSER_ONLY,
    deleteRule: SUPERUSER_ONLY,
  }));

  // ── backends ───────────────────────────────────────────────────
  ensure("backends", () => new Collection({
    name: "backends",
    type: "base",
    fields: [
      { name: "instance_id",          type: "text",   max: 128 },
      { name: "label",                type: "text",   max: 80 },
      { name: "tier",                 type: "text",   max: 8 },
      { name: "gpu_name",             type: "text",   max: 128 },
      { name: "status",               type: "text",   max: 32 },
      { name: "url",                  type: "text",   max: 400 },
      { name: "started_at",           type: "number" },
      { name: "last_seen_at",         type: "number" },
      { name: "active_job_id",        type: "text",   max: 64 },
    ],
    indexes: [
      "CREATE INDEX idx_backends_status_last_seen ON backends (status, last_seen_at)",
    ],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── channels ───────────────────────────────────────────────────
  ensure("channels", () => new Collection({
    name: "channels",
    type: "base",
    fields: [
      { name: "name",                 type: "text",   max: 80 },
      { name: "niche",                type: "text",   max: 60 },
      { name: "daily_count",          type: "number", min: 0, max: 10 },
      { name: "enabled",              type: "bool" },
      { name: "description",          type: "text",   max: 500 },
      { name: "web_research",         type: "bool" },
      { name: "real_events",          type: "bool" },
      { name: "language",             type: "text",   max: 5 },
      { name: "voice",                type: "text",   max: 80 },
      { name: "youtube_account_id",   type: "text",   max: 80 },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_channels_name ON channels (name)"],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── youtube_accounts ───────────────────────────────────────────
  ensure("youtube_accounts", () => new Collection({
    name: "youtube_accounts",
    type: "base",
    fields: [
      { name: "youtube_channel_id",   type: "text",   max: 80 },
      { name: "title",                type: "text",   max: 200 },
      { name: "thumbnail",            type: "text",   max: 400 },
      { name: "credentials",          type: "text",   max: 4000 },
    ],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── api_keys ───────────────────────────────────────────────────
  ensure("api_keys", () => new Collection({
    name: "api_keys",
    type: "base",
    fields: [
      { name: "value",                type: "text",   max: 4000 },
    ],
    listRule: SUPERUSER_ONLY, viewRule: SUPERUSER_ONLY,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── settings ───────────────────────────────────────────────────
  ensure("settings", () => new Collection({
    name: "settings",
    type: "base",
    fields: [
      { name: "doc",                  type: "json",   maxSize: 200000 },
    ],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── runs_index ─────────────────────────────────────────────────
  ensure("runs_index", () => new Collection({
    name: "runs_index",
    type: "base",
    fields: [
      { name: "run_id",               type: "text",   max: 64 },
      { name: "channel",              type: "text",   max: 80 },
      { name: "status",               type: "text",   max: 32 },
      { name: "started_at",           type: "number" },
      { name: "finished_at",          type: "number" },
      { name: "duration_seconds",     type: "number" },
      { name: "title",                type: "text",   max: 200 },
      { name: "video_url",            type: "text",   max: 600 },
      { name: "public_url",           type: "text",   max: 600 },
      { name: "video_storage",        type: "text",   max: 32 },
      { name: "youtube_video_id",     type: "text",   max: 32 },
      { name: "thumbnail_url",        type: "text",   max: 600 },
      { name: "word_count",           type: "number" },
      { name: "error",                type: "text",   max: 2000 },
    ],
    indexes: [
      "CREATE INDEX idx_runs_index_status_finished ON runs_index (status, finished_at)",
      "CREATE INDEX idx_runs_index_channel_finished ON runs_index (channel, finished_at)",
      "CREATE UNIQUE INDEX idx_runs_index_run_id ON runs_index (run_id)",
    ],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── run_summaries ──────────────────────────────────────────────
  ensure("run_summaries", () => new Collection({
    name: "run_summaries",
    type: "base",
    fields: [
      { name: "run_id",               type: "text",   max: 64 },
      { name: "doc",                  type: "json",   maxSize: 2000000 },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_run_summaries_run ON run_summaries (run_id)"],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── run_logs (flat replacement for Firestore subcollection) ───
  ensure("run_logs", () => new Collection({
    name: "run_logs",
    type: "base",
    fields: [
      { name: "run_id",               type: "text",   max: 64 },
      { name: "ts",                   type: "number" },
      { name: "level",                type: "text",   max: 16 },
      { name: "msg",                  type: "text",   max: 4000 },
      { name: "req_id",               type: "text",   max: 32 },
    ],
    indexes: ["CREATE INDEX idx_run_logs_run_ts ON run_logs (run_id, ts)"],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── errors ─────────────────────────────────────────────────────
  ensure("errors", () => new Collection({
    name: "errors",
    type: "base",
    fields: [
      { name: "ts",                   type: "number" },
      { name: "level",                type: "text",   max: 16 },
      { name: "kind",                 type: "text",   max: 64 },
      { name: "title",                type: "text",   max: 200 },
      { name: "message",              type: "text",   max: 2000 },
      { name: "stack",                type: "text",   max: 8000 },
      { name: "run_id",               type: "text",   max: 64 },
      { name: "req_id",               type: "text",   max: 32 },
      { name: "worker_label",         type: "text",   max: 80 },
      { name: "extra",                type: "json",   maxSize: 50000 },
    ],
    indexes: [
      "CREATE INDEX idx_errors_ts ON errors (ts)",
      "CREATE INDEX idx_errors_run ON errors (run_id, ts)",
    ],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── queue_state ────────────────────────────────────────────────
  ensure("queue_state", () => new Collection({
    name: "queue_state",
    type: "base",
    fields: [
      { name: "doc",                  type: "json",   maxSize: 50000 },
    ],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── idempotency ────────────────────────────────────────────────
  ensure("idempotency", () => new Collection({
    name: "idempotency",
    type: "base",
    fields: [
      { name: "key",                  type: "text",   max: 200 },
      { name: "job_id",               type: "text",   max: 64 },
      { name: "ts",                   type: "number" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_idempotency_key ON idempotency (key)"],
    listRule: SUPERUSER_ONLY, viewRule: SUPERUSER_ONLY,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── schedules ──────────────────────────────────────────────────
  ensure("schedules", () => new Collection({
    name: "schedules",
    type: "base",
    fields: [
      { name: "doc",                  type: "json",   maxSize: 50000 },
    ],
    listRule: OPEN, viewRule: OPEN,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  // ── storage_providers ──────────────────────────────────────────
  ensure("storage_providers", () => new Collection({
    name: "storage_providers",
    type: "base",
    fields: [
      { name: "name",                 type: "text",   max: 80 },
      { name: "kind",                 type: "text",   max: 32 },
      { name: "endpoint",             type: "text",   max: 300 },
      { name: "bucket",               type: "text",   max: 100 },
      { name: "region",               type: "text",   max: 50 },
      { name: "access_key_id",        type: "text",   max: 200 },
      { name: "secret_access_key",    type: "text",   max: 2000 },
      { name: "public_base",          type: "text",   max: 300 },
      { name: "path_style",           type: "bool" },
      { name: "host",                 type: "text",   max: 200 },
      { name: "port",                 type: "number" },
      { name: "user",                 type: "text",   max: 100 },
      { name: "password",             type: "text",   max: 2000 },
      { name: "base_dir",             type: "text",   max: 200 },
      { name: "is_primary",           type: "bool" },
      { name: "is_mirror",            type: "bool" },
      { name: "enabled",              type: "bool" },
      { name: "last_health_ok",       type: "bool" },
      { name: "last_health_check",    type: "number" },
      { name: "last_health_message",  type: "text",   max: 300 },
      { name: "extras",               type: "json",   maxSize: 50000 },
    ],
    indexes: [
      "CREATE INDEX idx_storage_primary ON storage_providers (is_primary)",
      "CREATE INDEX idx_storage_mirror ON storage_providers (is_mirror)",
    ],
    listRule: SUPERUSER_ONLY, viewRule: SUPERUSER_ONLY,
    createRule: SUPERUSER_ONLY, updateRule: SUPERUSER_ONLY, deleteRule: SUPERUSER_ONLY,
  }));

  console.log("[pb-migrate] 0001_initial_schema: done");
}, (app) => {
  // Down migration.
  const drop = (name) => {
    try {
      const c = app.findCollectionByNameOrId(name);
      if (c) app.delete(c);
    } catch (_e) { /* not present */ }
  };
  [
    "jobs", "backends", "channels", "youtube_accounts", "api_keys",
    "settings", "runs_index", "run_summaries", "run_logs", "errors",
    "queue_state", "idempotency", "schedules", "storage_providers",
  ].forEach(drop);
});
