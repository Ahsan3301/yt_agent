/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0034 — per-user trial quotas, and requests to raise them.
 *
 * The referral reward granted DAYS and nothing else. Nothing anywhere
 * said how many channels a trial user may attach or how many videos a
 * day they may render, so a trial and a paid account were identical in
 * every respect except an expiry date. The limits existed only as an
 * intention.
 *
 * Fields land on `app_users` because entitlement is a property of the
 * account, not of a plan row — a plan sets the DEFAULT, an operator
 * override sets THIS user, and the override has to survive a plan
 * change. Reading a limit therefore means: user override if present,
 * else plan default.
 *
 * DECLARE BEFORE WRITE. PocketBase silently drops writes to undeclared
 * fields — it does not error. That has bitten this project four times
 * now (0031 has_video, 0032 inbound forms, 0033 unlocked_at, and the
 * platform_config write earlier today), each presenting as a feature
 * that appeared to work until someone read the row back. Every field
 * the quota code will write is declared here first, in one migration,
 * before any of that code exists.
 *
 * TRIAL TERMS encoded as defaults, not as constants in code:
 *   5 approved referrals  -> 7 days, 1 channel, 1 video/day
 *   +4 more approved      -> +7 days, automatically
 * Defaults live in the schema so an operator can move a single user
 * without a deploy, which is the whole point of an override column.
 *
 * `quota_requests` is a separate collection rather than a flag on the
 * user, because a request has its own lifecycle (asked -> approved or
 * denied, by whom, when) and a user may ask more than once. Collapsing
 * that onto the user row would lose the history the operator needs to
 * decide.
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

  // ── Per-user quota overrides on app_users ──────────────────────
  //
  // 0 is NOT "unlimited" and not "none" — it is "unset, fall back to
  // the plan". An explicit 0 limit would be indistinguishable from an
  // absent one on a numeric column, so the resolver treats <= 0 as
  // absent and the plan default answers. An operator who genuinely
  // wants to stop a user suspends the account rather than zeroing a
  // quota, which is clearer to everyone including the user.
  addField("app_users", {
    name: "quota_channels", type: "number", required: false, min: 0,
  });
  addField("app_users", {
    name: "quota_videos_per_day", type: "number", required: false, min: 0,
  });

  // When the trial ends. Written by the referral grant, which already
  // computes an expiry — 0033 captured it in the ledger but there was
  // no field on the user for the pipeline to actually check.
  addField("app_users", {
    name: "trial_expires_at", type: "number", required: false, min: 0,
  });

  // Cumulative days granted by referrals. Kept separately from the
  // expiry so an extension can be additive and auditable: the expiry
  // answers "is the trial live", this answers "how much did they
  // earn". Recomputing days from the expiry is impossible once an
  // operator adjusts it by hand.
  addField("app_users", {
    name: "trial_days_granted", type: "number", required: false, min: 0,
  });

  // Approved-referral count at the last grant. The auto-extension
  // fires on crossing a threshold, and without a high-water mark a
  // recount re-grants: exactly the idempotency hole 0033 fixed for
  // rewards, reappearing here for extensions.
  addField("app_users", {
    name: "trial_referrals_at_grant", type: "number", required: false, min: 0,
  });

  // ── Quota increase requests ────────────────────────────────────
  const existing = (() => {
    try { return app.findCollectionByNameOrId("quota_requests"); }
    catch (_e) { return null; }
  })();

  if (existing) {
    console.log("[pb-migrate] quota_requests: already present");
  } else {
    const coll = new Collection({
      name: "quota_requests",
      type: "base",
      // Server-side only. The dashboard writes through the admin
      // client, so leaving every rule null means no public API access
      // to other people's requests — the same posture the rest of the
      // operator-facing collections use.
      listRule: null, viewRule: null,
      createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { name: "user_id", type: "text", required: true, max: 64 },
        { name: "email", type: "text", required: false, max: 320 },
        // What they are asking for. Null/0 on a field means "not
        // asking about this one" — a user wanting more videos should
        // not have to restate their channel count.
        { name: "want_channels", type: "number", required: false, min: 0 },
        { name: "want_videos_per_day", type: "number", required: false, min: 0 },
        { name: "want_days", type: "number", required: false, min: 0 },
        { name: "reason", type: "text", required: false, max: 2000 },
        {
          name: "status", type: "select", required: true, maxSelect: 1,
          values: ["pending", "approved", "denied"],
        },
        // What the operator actually granted, which may differ from
        // what was asked. Recording both is what makes the ledger
        // worth keeping.
        { name: "granted_channels", type: "number", required: false, min: 0 },
        { name: "granted_videos_per_day", type: "number", required: false, min: 0 },
        { name: "granted_days", type: "number", required: false, min: 0 },
        { name: "decided_by", type: "text", required: false, max: 64 },
        { name: "decided_at", type: "number", required: false, min: 0 },
        { name: "note", type: "text", required: false, max: 2000 },
        {
          name: "created_at", type: "autodate", onCreate: true, onUpdate: false,
        },
      ],
      indexes: [
        "CREATE INDEX idx_quota_requests_user ON quota_requests (user_id)",
        "CREATE INDEX idx_quota_requests_status ON quota_requests (status)",
      ],
    });
    app.save(coll);
    console.log("[pb-migrate] quota_requests: created");
  }

  // ── Backfill ───────────────────────────────────────────────────
  //
  // Existing accounts predate trials and must not be retroactively
  // limited: leaving their overrides unset means they resolve to their
  // plan, which is what they have been running on all along. Only
  // trial_* is zeroed, so "no trial" is stated rather than inferred
  // from a missing field.
  try {
    const users = app.findRecordsByFilter("app_users", "id != ''", "", 500, 0);
    let n = 0;
    for (const u of users) {
      if (u.get("trial_expires_at") === "" || u.get("trial_expires_at") == null) {
        u.set("trial_expires_at", 0);
        u.set("trial_days_granted", 0);
        u.set("trial_referrals_at_grant", 0);
        app.save(u);
        n += 1;
      }
    }
    console.log(`[pb-migrate] app_users: trial fields initialised on ${n} row(s)`);
  } catch (e) {
    console.log(`[pb-migrate] app_users backfill skipped: ${e}`);
  }
}, (app) => {
  // Down: drop the added fields and the collection. Field removal is
  // safe here because nothing outside the quota feature reads them.
  const names = [
    "quota_channels", "quota_videos_per_day", "trial_expires_at",
    "trial_days_granted", "trial_referrals_at_grant",
  ];
  try {
    const coll = app.findCollectionByNameOrId("app_users");
    for (const n of names) {
      const f = coll.fields.find((x) => x.name === n);
      if (f) coll.fields.removeById(f.id);
    }
    app.save(coll);
  } catch (_e) { /* collection gone — nothing to undo */ }
  try { app.delete(app.findCollectionByNameOrId("quota_requests")); }
  catch (_e) { /* never created */ }
});
