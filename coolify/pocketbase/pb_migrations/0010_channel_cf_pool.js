/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0010 — per-channel Cloudflare account pool.
 *
 * When a channel is in `cf_source=own` mode, it can supply either:
 *   - a single account (cloudflare_account_id + cloudflare_api_token), OR
 *   - a JSON pool (cloudflare_pool) of the same shape as the global
 *     CLOUDFLARE_ACCOUNTS_JSON at /keys — the render will rotate
 *     across these when one hits its daily quota.
 *
 * Pool wins over single-account creds when both are set. Empty pool =
 * legacy single-account behaviour (backwards compat).
 *
 * Same-shape field also added to the jobs collection so render-now /
 * scheduled-render can propagate the channel's pool per render.
 */
migrate((app) => {
  function addField(collName, field) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); }
    catch (_e) { console.log(`[pb-migrate] ${collName}: missing — skipping ${field.name}`); return; }
    const has = (coll.fields || []).some((f) => f.name === field.name);
    if (has) { console.log(`[pb-migrate] ${collName}.${field.name}: exists, skipping`); return; }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collName}.${field.name}: added`);
  }
  // 5000 chars is enough for ~10 accounts (each entry ~400 chars).
  addField("channels", { name: "cloudflare_pool", type: "text", max: 5000 });
  addField("jobs",     { name: "cf_pool",         type: "text", max: 5000 });
}, (app) => {});
