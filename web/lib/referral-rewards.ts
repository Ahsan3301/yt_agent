import { adminDb } from "@/lib/firebase-admin";

/**
 * Turning referral counts into actual entitlement.
 *
 * Kept separate from lib/referrals.ts on purpose. That file owns
 * COUNTING — codes, attribution, who joined. This one owns PAYING OUT —
 * reading a count and extending a plan. They change for different
 * reasons: the counting rules are stable, the reward tiers are a
 * commercial decision someone will want to tune. Splitting them means
 * changing the offer never risks the attribution logic that decides who
 * earned it.
 *
 * The reward itself is expressed as free days on `plan_expires_at`,
 * because that field already exists and quota.ts already downgrades a
 * user to "free" at read time once it passes. Nothing new has to be
 * taught about expiry, and a granted trial cannot outlive its date even
 * if some other code path forgets to check.
 */

/** Reward tiers, lowest first. `at` = approved referrals required. */
export const REWARD_TIERS: Array<{ at: number; days: number; label: string }> = [
  { at: 5,  days: 14, label: "14 days free" },
  { at: 10, days: 30, label: "1 month free" },
];

/** Plan a referral reward grants. Must exist in the `plans` collection. */
export const REWARD_PLAN_ID = "pro";

export type GrantResult = {
  granted: Array<{ tier: number; days: number; expires_after: number }>;
  joined_count: number;
  /** Expiry after all grants, or null when nothing was granted. */
  expires_at: number | null;
};

/**
 * Grant every tier this user has earned and not yet been paid for.
 *
 * Idempotent by construction: `referral_rewards` has a UNIQUE index on
 * (user_id, tier), so a duplicate grant fails at the database rather
 * than relying on a check-then-write that two concurrent approvals
 * could both pass. A user who re-crosses a threshold gets nothing extra.
 *
 * Never throws — it runs inside the approval flow, and a reward failing
 * must not block a user being approved. Returns what it actually did.
 */
export async function grantEarnedRewards(
  userId: string,
  joinedCount: number,
): Promise<GrantResult> {
  const out: GrantResult = { granted: [], joined_count: joinedCount, expires_at: null };
  if (!userId || joinedCount <= 0) return out;

  const earned = REWARD_TIERS.filter((t) => joinedCount >= t.at);
  if (earned.length === 0) return out;

  let alreadyPaid = new Set<number>();
  try {
    const prior = await adminDb().collection("referral_rewards")
      .where("user_id", "==", userId).limit(50).get();
    prior.forEach((d) => {
      const t = Number((d.data() as { tier?: number }).tier || 0);
      if (t) alreadyPaid.add(t);
    });
  } catch {
    // Cannot prove what was already granted → do NOT grant. Paying a
    // reward twice is worse than paying it late: the second is fixed by
    // the next approval, the first is free product already given away.
    return out;
  }

  const owed = earned.filter((t) => !alreadyPaid.has(t.at));
  if (owed.length === 0) return out;

  let userDoc, user: Record<string, unknown>;
  try {
    userDoc = await adminDb().collection("app_users").doc(userId).get();
    if (!userDoc.exists) return out;
    user = (userDoc.data() || {}) as Record<string, unknown>;
  } catch {
    return out;
  }

  const now = Math.floor(Date.now() / 1000);
  const planBefore = String(user.plan_id || "free");
  // Extend from whichever is later: now, or an expiry still in the
  // future. Extending from `now` alone would silently shorten a paid
  // subscription as a "reward" for referring people.
  let cursor = Math.max(now, Number(user.plan_expires_at || 0) || 0);
  const expiresBefore = Number(user.plan_expires_at || 0) || 0;

  for (const tier of owed) {
    const after = cursor + tier.days * 86400;
    try {
      // Ledger row FIRST. If the unique index rejects it, this tier was
      // already paid by a concurrent run and we must not also extend
      // the plan. Writing the plan first would double-grant on a race.
      await adminDb().collection("referral_rewards").doc().set({
        user_id: userId,
        tier: tier.at,
        days_granted: tier.days,
        expires_before: cursor,
        expires_after: after,
        plan_before: planBefore,
        joined_count: joinedCount,
        note: `${tier.label} for ${tier.at} approved referrals`,
        granted_at: now,
      });
    } catch {
      continue;   // already granted (unique index) or write failed
    }
    out.granted.push({ tier: tier.at, days: tier.days, expires_after: after });
    cursor = after;
  }

  if (out.granted.length === 0) return out;

  try {
    await adminDb().collection("app_users").doc(userId).set({
      plan_id: REWARD_PLAN_ID,
      plan_expires_at: cursor,
      plan_assigned_at: now,
      plan_assigned_by: "referral-reward",
      plan_note: `Referral reward: ${out.granted.map((g) => `${g.days}d`).join(" + ")} `
                 + `(${joinedCount} approved referrals)`,
    }, { merge: true });
    out.expires_at = cursor;
  } catch {
    // The ledger says granted but the plan write failed. Deliberately
    // NOT rolled back: the ledger is the audit trail, and an operator
    // can see exactly what was owed and re-apply it. Silently deleting
    // the evidence would leave nothing to reconcile against.
    out.expires_at = null;
  }

  // Best-effort cache bust so the new plan is visible immediately
  // rather than after the 60s quota cache expires.
  try {
    const { bustQuotaCache } = await import("@/lib/quota");
    bustQuotaCache?.(userId);
  } catch { /* cache is an optimisation, not a correctness requirement */ }

  return out;
}

/** What this user has been paid, for the dashboard. */
export async function getRewardHistory(userId: string): Promise<Array<{
  tier: number; days_granted: number; granted_at: number; expires_after: number; note: string;
}>> {
  try {
    const snap = await adminDb().collection("referral_rewards")
      .where("user_id", "==", userId).limit(50).get();
    const rows: Array<Record<string, unknown>> = [];
    snap.forEach((d) => rows.push(d.data() as Record<string, unknown>));
    // Sorted here rather than via orderBy: PocketBase 400s on an
    // orderBy without a matching index, and this is at most a handful
    // of rows per user.
    return rows
      .map((r) => ({
        tier: Number(r.tier || 0),
        days_granted: Number(r.days_granted || 0),
        granted_at: Number(r.granted_at || 0),
        expires_after: Number(r.expires_after || 0),
        note: String(r.note || ""),
      }))
      .sort((a, b) => b.granted_at - a.granted_at);
  } catch {
    return [];
  }
}

/** Next unearned tier, for "N more to go" copy. Null when all earned. */
export function nextTier(joinedCount: number): { at: number; days: number; label: string } | null {
  return REWARD_TIERS.find((t) => joinedCount < t.at) || null;
}
