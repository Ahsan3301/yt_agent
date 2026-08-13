/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0033 — make the referral unlock real.
 *
 * The referral system was display-only. It counted joins and drew a
 * progress ring, and nothing it computed ever changed what a user could
 * do. The success card literally told them to "ask an operator to
 * upgrade you", which is not a reward, it is a support ticket.
 *
 * Two schema problems behind that:
 *
 * 1. `referrals.unlocked_at` was WRITTEN by lib/referrals.ts and never
 *    DECLARED here, so PocketBase silently dropped every write. The
 *    unlock did not even persist, let alone grant anything. Same class
 *    as runs_index.has_video (0031) and the inbound-form fields (0032):
 *    an undeclared column looks like a working feature right up until
 *    someone reads the row back.
 *
 * 2. There was nowhere to record that a reward had been granted, so a
 *    grant could not be made idempotent. Without that, any recount —
 *    a re-approval, a replayed webhook, a manual fix — would hand out
 *    the same free days again.
 *
 * `referral_rewards` is an append-only ledger: one row per tier per
 * user, with the before/after expiry captured. That makes the grant
 * idempotent (row exists = already given), auditable (what did we
 * actually hand out, and when), and reversible (the previous expiry is
 * right there).
 */
migrate((app) => {
  function addField(collName, field) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); }
    catch (_e) { console.log(`[pb-migrate] ${collName}: missing — skipping ${field.name}`); return; }
    if ((coll.fields || []).some((f) => f.name === field.name)) {
      console.log(`[pb-migrate] ${collName}.${field.name}: exists, skipping`);
      return;
    }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collName}.${field.name}: added`);
  }

  // The field the code has been writing into the void since 0018.
  addField("referrals", { name: "unlocked_at", type: "number" });
  // Highest tier already granted, so the common "do they deserve more?"
  // check is one field read instead of a ledger scan.
  addField("referrals", { name: "top_tier", type: "number" });

  try {
    app.findCollectionByNameOrId("referral_rewards");
    console.log("[pb-migrate] referral_rewards: exists, skipping");
  } catch (_e) {
    app.save(new Collection({
      name: "referral_rewards",
      type: "base",
      fields: [
        { name: "user_id",         type: "text",   max: 32 },
        // How many approved referrals this tier required (5 or 10).
        { name: "tier",            type: "number" },
        { name: "days_granted",    type: "number" },
        // Captured so a grant can be explained or undone later without
        // guessing what the state was before it.
        { name: "expires_before",  type: "number" },
        { name: "expires_after",   type: "number" },
        { name: "plan_before",     type: "text",   max: 40 },
        { name: "joined_count",    type: "number" },
        { name: "note",            type: "text",   max: 300 },
        { name: "granted_at",      type: "number" },
      ],
      indexes: [
        // The idempotency guarantee. One row per (user, tier), enforced
        // by the database rather than by a check-then-write in app code
        // that two concurrent approvals could both pass.
        "CREATE UNIQUE INDEX idx_refrew_user_tier ON referral_rewards (user_id, tier)",
        "CREATE INDEX idx_refrew_granted ON referral_rewards (granted_at)",
      ],
      listRule: null, viewRule: null, createRule: null,
      updateRule: null, deleteRule: null,
    }));
    console.log("[pb-migrate] referral_rewards: created");
  }

  console.log("[pb-migrate] 0033_referral_rewards: done");
}, (app) => {
  try {
    const c = app.findCollectionByNameOrId("referral_rewards");
    if (c) app.delete(c);
  } catch (_e) { /* already gone */ }
});
