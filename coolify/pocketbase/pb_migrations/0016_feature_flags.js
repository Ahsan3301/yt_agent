/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0016 — insert the settings/flags singleton row.
 *
 * Part of the multi-tenant SaaS refactor (Phase 0). Every SaaS-related
 * code path (auth-v2, tenant filtering, signup, quotas, shared worker
 * pool, landing CMS) is gated behind a boolean in this row. Toggling
 * a flag from the /superadmin/flags UI (added in Phase 6) changes
 * behaviour instantly, no redeploy — the flags are re-read on every
 * request via the same `settings_sync` mechanism keys already use.
 *
 * ALL flags default to FALSE so the moment this migration lands the
 * old single-tenant behaviour is preserved. Each subsequent phase
 * flips exactly one flag when its code is verified working.
 *
 * The row lives in the existing `settings` collection at id="flags"
 * (via the deterministic `_pb_id("flags")` shared between the JS
 * and Python helpers).
 */
migrate((app) => {
  let coll;
  try { coll = app.findCollectionByNameOrId("settings"); }
  catch (_e) { console.log("[pb-migrate] settings: missing — skipping 0016"); return; }

  // Deterministic id computed via the shared _pbId() helper:
  //   sha256("flags") -> base64 -> lowercase -> strip non-alphanum
  //   -> take first 15 chars.
  // Verified against the running JS+Python helpers to equal
  // "ktt7sdazit7wnsk". Hardcoded here because PB migrations run
  // inside Goja which lacks the crypto+base64 stdlib needed to
  // recompute it. If the algorithm ever changes, update this
  // constant AND rewrite the readers in lockstep.
  const flagsId = "ktt7sdazit7wnsk";

  // Check-then-create; migrations must be idempotent.
  let existing;
  try { existing = app.findRecordById("settings", flagsId); } catch (_e) { existing = null; }
  if (existing) {
    console.log(`[pb-migrate] settings/${flagsId} (flags): exists, skipping`);
    return;
  }

  const rec = new Record(coll);
  rec.set("id", flagsId);
  rec.set("data", JSON.stringify({
    // Phase 1 flips this ON when the auth-v2 code deploys.
    auth_v2_enabled: false,
    // Phase 2 flips this ON per-collection incrementally.
    tenant_filter_enforced: false,
    // Phase 4 flips this ON when you're ready for the public.
    signup_open: false,
    // Phase 5 flips this ON when plans/quotas are ready.
    quotas_enforced: false,
    // Phase 5 flips this ON to allow paid users onto shared workers.
    shared_pool_enabled: false,
    // Phase 4 flips this ON when landing CMS content is populated.
    landing_cms_enabled: false,
  }));
  rec.set("updated_at", Math.floor(Date.now() / 1000));
  app.save(rec);
  console.log(`[pb-migrate] settings/${flagsId} (flags): created (all flags OFF)`);
}, (app) => {
  try {
    const r = app.findRecordById("settings", "ktt7sdazit7wnsk");
    if (r) app.delete(r);
  } catch (_e) { /* not present */ }
});
