/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0035 — plans.max_renders_day.
 *
 * lib/quota resolves a "renders_day" cap and reads plan.max_renders_day.
 * That field was never declared, so the lookup returned undefined,
 * _isUnlimited() answered true, and a per-day cap set on a PLAN did
 * nothing at all.
 *
 * Nothing was broken by it yet: the referral trial caps days through the
 * per-USER override (quota_videos_per_day, migration 0034), which works.
 * The hole only opens when a paid package tries to say "3 videos a day" —
 * the plan would save the number, the UI would display it, and the guard
 * would ignore it. Silent, and exactly the shape of every field bug this
 * project has hit: 0031 has_video, 0032 inbound forms, 0033 unlocked_at.
 *
 * Declared BEFORE any pricing data lands, so the first plan that uses it
 * is enforced rather than decorative.
 *
 * 0 or null stays "unlimited" here, matching max_channels and
 * max_renders_month. That compat rule predates this field and the founder
 * plan relies on it; a different convention for one column would be its
 * own bug.
 */
migrate((app) => {
  let coll;
  try { coll = app.findCollectionByNameOrId("plans"); }
  catch (_e) { console.log("[pb-migrate] plans: missing — skipping"); return; }

  if (coll.fields.find((f) => f.name === "max_renders_day")) {
    console.log("[pb-migrate] plans.max_renders_day: already present");
    return;
  }
  coll.fields.add(new Field({
    name: "max_renders_day", type: "number", required: false, min: 0,
  }));
  app.save(coll);
  console.log("[pb-migrate] plans.max_renders_day: added");

  // Existing plans keep an unset (unlimited) daily cap. Back-filling a
  // number here would silently tighten limits on live accounts, which
  // is a pricing decision and not a migration's to make.
  try {
    const rows = app.findRecordsByFilter("plans", "id != ''", "", 200, 0);
    let n = 0;
    for (const r of rows) {
      if (r.get("max_renders_day") === "" || r.get("max_renders_day") == null) {
        r.set("max_renders_day", 0);   // 0 = unlimited, same as the siblings
        app.save(r);
        n += 1;
      }
    }
    console.log(`[pb-migrate] plans: max_renders_day initialised to 0 on ${n} row(s)`);
  } catch (e) {
    console.log(`[pb-migrate] plans backfill skipped: ${e}`);
  }
}, (app) => {
  try {
    const coll = app.findCollectionByNameOrId("plans");
    const f = coll.fields.find((x) => x.name === "max_renders_day");
    if (f) { coll.fields.removeById(f.id); app.save(coll); }
  } catch (_e) { /* nothing to undo */ }
});
