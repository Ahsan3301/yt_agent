/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0014 — relax channels UNIQUE(name) → UNIQUE(user_id, name).
 *
 * Part of the multi-tenant SaaS refactor (Phase 0). Two different
 * tenants must be allowed to name a channel "Orbitarium" without
 * colliding. SQLite's UNIQUE(a, b) treats NULL != NULL, so during
 * the Phase-0/1 window (before user_id is backfilled to u_founder)
 * existing rows with user_id=NULL do NOT collide with each other —
 * safe because there's only one tenant today.
 *
 * The Phase-1 migrate_to_multitenant.py script backfills every
 * channels row to user_id="u_founder" before Phase 2 ships, at
 * which point the composite unique starts enforcing per-tenant
 * name uniqueness for real.
 *
 * ROLLBACK: recreates the original single-column unique. If two
 * rows share a name at rollback time (impossible today, but a
 * safety net), the down migration will error out — recover by
 * dropping the composite unique manually and reconciling.
 */
migrate((app) => {
  let coll;
  try { coll = app.findCollectionByNameOrId("channels"); }
  catch (_e) { console.log("[pb-migrate] channels: missing — skipping 0014"); return; }

  const NEW_IDX_NAME  = "idx_channels_user_name";
  const OLD_IDX_NAME  = "idx_channels_name";
  const NEW_IDX_SQL   = "CREATE UNIQUE INDEX " + NEW_IDX_NAME + " ON channels (user_id, name)";

  const existing = coll.indexes || [];
  const hasNew  = existing.some((s) => String(s).includes(NEW_IDX_NAME));
  const hasOld  = existing.some((s) => String(s).includes(OLD_IDX_NAME));

  if (hasNew && !hasOld) {
    console.log("[pb-migrate] 0014: already migrated, skipping");
    return;
  }

  // Rebuild the indexes array: drop OLD, add NEW (idempotent — no
  // duplicates possible because we just checked).
  const nextIndexes = existing.filter((s) => !String(s).includes(OLD_IDX_NAME));
  if (!hasNew) nextIndexes.push(NEW_IDX_SQL);
  coll.indexes = nextIndexes;
  app.save(coll);
  console.log("[pb-migrate] channels: swapped UNIQUE(name) → UNIQUE(user_id, name)");
}, (app) => {
  let coll;
  try { coll = app.findCollectionByNameOrId("channels"); } catch (_e) { return; }
  const OLD_IDX_SQL = "CREATE UNIQUE INDEX idx_channels_name ON channels (name)";
  const nextIndexes = (coll.indexes || []).filter((s) => !String(s).includes("idx_channels_user_name"));
  if (!nextIndexes.some((s) => String(s).includes("idx_channels_name"))) nextIndexes.push(OLD_IDX_SQL);
  coll.indexes = nextIndexes;
  app.save(coll);
});
