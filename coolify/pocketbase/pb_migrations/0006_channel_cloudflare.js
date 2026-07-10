/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0006 — per-channel Cloudflare Workers AI credentials.
 *
 * Adds three fields to `channels`:
 *   cloudflare_source        text  — "off" | "own" | "global"
 *   cloudflare_account_id    text  — 32-char CF account id, own mode only
 *   cloudflare_api_token     text  — CF API token, own mode only
 *
 * Rules enforced in web/app/api/channels/route.ts, not here:
 *   - "own"    → account_id + api_token required, no operator password
 *   - "global" → operator MUST supply ORACLE_UNLOCK_PASSWORD to switch
 *                into this mode; the two id/token fields stay empty
 *   - "off"    → default; provider skipped entirely on this channel
 *
 * GET /api/channels strips both plaintext fields and projects
 * `has_cloudflare_own_creds` bool so the UI knows they're set without
 * ever reading the value back.
 */
migrate((app) => {
  function addField(coll, field) {
    const has = (coll.fields || []).some((f) => f.name === field.name);
    if (has) { console.log(`[pb-migrate] channels.${field.name}: exists, skipping`); return; }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] channels.${field.name}: added`);
  }
  let coll;
  try { coll = app.findCollectionByNameOrId("channels"); }
  catch (_e) { console.log("[pb-migrate] channels: missing — skipping CF fields"); return; }

  addField(coll, { name: "cloudflare_source",     type: "text", max: 10 });
  addField(coll, { name: "cloudflare_account_id", type: "text", max: 64 });
  addField(coll, { name: "cloudflare_api_token",  type: "text", max: 200 });
}, (app) => {
  // no down
});
