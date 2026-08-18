/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0036 — review prompt state.
 *
 * After a few published videos a free user is asked to review Yven on
 * G2 or Capterra. The ask is SKIPPABLE, so the state that matters is
 * "when did they last dismiss it" — without that, dismissing would only
 * last until the next page load and the prompt would become the thing
 * it is trying not to be.
 *
 * Fields, and why each exists rather than being derived:
 *
 *   review_prompt_dismissed_at  Last dismissal. The prompt returns after
 *                               a cooling-off window, so this is a
 *                               timestamp and not a boolean — a boolean
 *                               could only ever mean "never ask again".
 *   review_prompt_shown_count   How many times we have asked. A prompt
 *                               that reappears forever is a nag; this is
 *                               what lets it give up.
 *   review_submitted_at         They told us they left one. Stops the
 *                               ask permanently, and is the only field
 *                               here anyone would want to report on.
 *
 * DECLARED BEFORE ANY WRITE. PocketBase silently drops writes to
 * undeclared fields, which has bitten this project five times now
 * (0031 has_video, 0032 inbound forms, 0033 unlocked_at, 0034's quota
 * columns, and plans.max_renders_day in 0035). A dropped dismissal here
 * would present as "the dismiss button does nothing", which is exactly
 * the complaint a nag screen generates anyway — so it would be blamed on
 * design rather than on a missing column.
 *
 * Nothing is gated on any of this. G2 and Capterra both prohibit review
 * gating — conditioning access, features or rewards on leaving a review
 * — and enforcement includes purging reviews and suspending the vendor
 * profile. The prompt asks; the product works either way.
 */
migrate((app) => {
  function addField(collName, field) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); }
    catch (_e) {
      console.log(`[pb-migrate] ${collName}: missing — skipping ${field.name}`);
      return;
    }
    if (coll.fields.find((f) => f.name === field.name)) {
      console.log(`[pb-migrate] ${collName}.${field.name}: already present`);
      return;
    }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collName}.${field.name}: added`);
  }

  addField("app_users", {
    name: "review_prompt_dismissed_at", type: "number", required: false, min: 0,
  });
  addField("app_users", {
    name: "review_prompt_shown_count", type: "number", required: false, min: 0,
  });
  addField("app_users", {
    name: "review_submitted_at", type: "number", required: false, min: 0,
  });

  // Existing users start at zero rather than unset, so "never asked" is
  // stated rather than inferred from a missing field — the same reason
  // 0034 initialised its trial columns.
  try {
    const users = app.findRecordsByFilter("app_users", "id != ''", "", 500, 0);
    let n = 0;
    for (const u of users) {
      const cur = u.get("review_prompt_shown_count");
      if (cur === "" || cur == null) {
        u.set("review_prompt_dismissed_at", 0);
        u.set("review_prompt_shown_count", 0);
        u.set("review_submitted_at", 0);
        app.save(u);
        n += 1;
      }
    }
    console.log(`[pb-migrate] app_users: review prompt fields initialised on ${n} row(s)`);
  } catch (e) {
    console.log(`[pb-migrate] app_users review backfill skipped: ${e}`);
  }
}, (app) => {
  const names = [
    "review_prompt_dismissed_at", "review_prompt_shown_count", "review_submitted_at",
  ];
  try {
    const coll = app.findCollectionByNameOrId("app_users");
    for (const n of names) {
      const f = coll.fields.find((x) => x.name === n);
      if (f) coll.fields.removeById(f.id);
    }
    app.save(coll);
  } catch (_e) { /* nothing to undo */ }
});
