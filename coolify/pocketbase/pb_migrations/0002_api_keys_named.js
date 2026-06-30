/// <reference path="../pb_data/types.d.ts" />

/**
 * Migration 0002 — NO-OP placeholder.
 *
 * Earlier this migration tried to add a `key_name` field to api_keys,
 * but used a Field constructor pattern that crashed Pocketbase boot
 * on v0.39. The dashboard restarted in a loop.
 *
 * Reverted to a no-op. The /api/keys route was instead reworked to
 * store all keys as a single JSON blob in the existing `settings`
 * collection (which already has a `data: json` field), so no schema
 * change is required.
 */
migrate((app) => {
  // intentional no-op
}, (app) => {
  // intentional no-op
});
