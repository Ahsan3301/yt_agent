/**
 * Plan quota enforcement helpers.
 *
 * A route calls `requirePlanQuota(userId, kind)` before creating a
 * new channel or submitting a render. When enforcement is on AND the
 * user is on a capped plan, over-limit calls return a 429-shaped
 * response the route surfaces verbatim.
 *
 * Founder plan and superadmin role always bypass. `tenant_filter_enforced`
 * flag controls whether tenancy applies (Phase 2); `quotas_enforced`
 * flag independently controls whether quotas fire (Phase 5). Both
 * default off — the founder never gets blocked.
 *
 * Values of 0 OR null on a plan's max_* field mean "unlimited" — the
 * founder plan uses 0 for both, so 0-as-unlimited is the compat rule.
 * Explicit caps must be a positive integer.
 *
 * Cached 60s per (userId, kind) so a busy dashboard poll doesn't spam
 * PB. Cache is bumped by `_bustQuotaCache(userId)` from write paths
 * so the count reflects the very next request.
 */
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { getFlag } from "@/lib/flags";
import type { Tenant } from "@/lib/tenant";

export type QuotaKind = "channels" | "renders_month" | "renders_day";

// ── Referral trial terms ────────────────────────────────────────
//
// A TABLE, not a formula. The terms are "refer 3 -> 7 days free, refer
// 5 -> 14 days free", and the days are ABSOLUTE totals rather than
// additive: at 5 referrals the trial is worth 14 days, not 7 + 14.
//
// This replaced an open-ended formula (5 unlocks 7 days, every further
// 4 adds 7 more). Anything that reads referral rewards — the public
// referrals page, the dashboard panel, the grant itself — resolves
// through here, so the marketing copy cannot drift from what the code
// actually hands out.
export const TRIAL_TIERS: Array<{ at: number; days: number; label: string }> = [
  { at: 3, days: 7,  label: "7 days free"  },
  { at: 5, days: 14, label: "14 days free" },
];

/** What a trial account may do while the free days run. */
export const TRIAL_CHANNELS = 1;
export const TRIAL_VIDEOS_PER_DAY = 1;

/**
 * Days a referral count is worth. Pure and total, so it is checkable
 * without a database.
 *
 * Highest matching tier wins. Below the first tier it is worth nothing,
 * and past the last it does not keep growing — the table is the whole
 * offer.
 */
export function daysForReferrals(approved: number): number {
  let days = 0;
  for (const t of TRIAL_TIERS) if (approved >= t.at) days = Math.max(days, t.days);
  return days;
}

/**
 * Days still owed, given what was already granted.
 *
 * The already-granted high-water mark is what makes extension
 * idempotent: a recount, re-approval or replayed webhook computes the
 * same total and owes zero. Without it every recount re-grants — the
 * hole migration 0033 closed for rewards, which would otherwise
 * reappear for extensions. It also makes the 3 -> 5 step work correctly:
 * someone who already took 7 days is owed exactly 7 more, not 14.
 */
export function pendingTrialDays(approved: number, alreadyGranted: number): number {
  return Math.max(0, daysForReferrals(approved) - Math.max(0, alreadyGranted));
}

const CACHE_TTL_MS = 60_000;
type CacheEntry = { at: number; used: number };
const _cache = new Map<string, CacheEntry>();

/** Fetch the user's plan doc. Returns null when no plan slug is set
 *  (treated as unlimited — pre-Phase-5 users). */
async function _resolvePlan(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const user = await adminDb().collection("app_users").doc(userId).get();
    if (!user.exists) return null;
    const d = (user.data() || {}) as Record<string, unknown>;
    let slug = String(d.plan_id || "").trim();
    if (!slug) return null;

    // Manual billing: payments happen outside the product, so nothing
    // ever tells us a subscription lapsed. An expiry that has passed
    // means the paid plan's limits no longer apply — fall back to
    // free rather than leaving someone on Pro indefinitely because
    // an operator forgot to downgrade them.
    //
    // Resolved at read time rather than relying solely on the nightly
    // sweep, so access is correct the moment the date passes even if
    // the sweep hasn't run.
    const expires = Number(d.plan_expires_at || 0);
    if (expires > 0 && expires < Math.floor(Date.now() / 1000)) {
      slug = "free";
    }

    const q = await adminDb().collection("plans").where("slug", "==", slug).limit(1).get();
    if (q.empty) return null;
    const doc = q.docs[0];
    return doc.data() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function _countChannels(userId: string): Promise<number> {
  try {
    const snap = await adminDb().collection("channels")
      .where("user_id", "==", userId).limit(500).get();
    return snap.size;
  } catch {
    return 0;
  }
}

/** Count non-cancelled render jobs the user submitted this UTC month. */
async function _countRendersThisMonth(userId: string): Promise<number> {
  try {
    const now = new Date();
    const startOfMonth = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const snap = await adminDb().collection("jobs")
      .where("user_id", "==", userId).limit(2000).get();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as { queued_at?: number; status?: string; kind?: string };
      if (Number(d.queued_at || 0) < startOfMonth) return;
      if (d.status === "cancelled") return;
      // Only count RENDER jobs — publish_youtube / copy_storage side-jobs
      // don't count against the render quota.
      if (d.kind && d.kind !== "render") return;
      n += 1;
    });
    return n;
  } catch {
    return 0;
  }
}

/** Count non-cancelled render jobs the user submitted today (UTC).
 *
 *  UTC, not local: scheduled renders dispatch on UTC hours, and a
 *  local-midnight window would hand someone near the date line two
 *  days of allowance in one. */
async function _countRendersToday(userId: string): Promise<number> {
  try {
    const startOfDay = Math.floor(
      Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z") / 1000);
    const snap = await adminDb().collection("jobs")
      .where("user_id", "==", userId).limit(2000).get();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as { queued_at?: number; status?: string; kind?: string };
      if (Number(d.queued_at || 0) < startOfDay) return;
      if (d.status === "cancelled") return;
      if (d.kind && d.kind !== "render") return;
      n += 1;
    });
    return n;
  } catch {
    return 0;
  }
}

/**
 * Operator override for this user, from migration 0034.
 *
 * Returns null when unset. `<= 0` is UNSET, not zero-allowance: on a
 * numeric column an explicit 0 cannot be told apart from an absent
 * value, so it falls through to the plan. Stopping a user is a
 * suspension, which tells them why instead of looking like a bug.
 *
 * An override BEATS the plan, including an unlimited one — that is the
 * point of granting a trial user exactly one channel while their plan
 * row still says free.
 */
async function _userOverride(userId: string, kind: QuotaKind): Promise<number | null> {
  if (kind === "renders_month") return null;   // trial terms are per-day
  try {
    const doc = await adminDb().collection("app_users").doc(userId).get();
    if (!doc.exists) return null;
    const d = (doc.data() || {}) as Record<string, unknown>;
    const raw = kind === "channels" ? d.quota_channels : d.quota_videos_per_day;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** True when the plan's cap for `kind` is unlimited (null / 0). */
function _isUnlimited(plan: Record<string, unknown> | null, kind: QuotaKind): boolean {
  if (!plan) return true;
  const key = kind === "channels" ? "max_channels"
            : kind === "renders_day" ? "max_renders_day"
            : "max_renders_month";
  const v = plan[key];
  if (v == null) return true;
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0;
}

/**
 * Route-level guard. Returns null when the caller is allowed to proceed;
 * returns a NextResponse (429) when they've exceeded their plan's cap
 * for the given resource. Route handlers should `return` the response
 * verbatim.
 *
 * Bypass conditions:
 *   - `quotas_enforced` flag is off
 *   - tenant is superadmin
 *   - user's plan has max_<kind> = 0 or null (unlimited)
 */
export async function requirePlanQuota(
  tenant: Tenant, kind: QuotaKind,
): Promise<NextResponse | null> {
  if (tenant.isSuper) return null;
  const on = await getFlag("quotas_enforced");
  if (!on) return null;

  // Operator override first — it beats the plan, including an
  // unlimited one. Without this precedence a trial user on the free
  // plan (max_channels = 0 = unlimited) would be capped by nothing,
  // which is exactly backwards for a trial.
  const override = await _userOverride(tenant.userId, kind);

  const plan = await _resolvePlan(tenant.userId);
  if (override == null && _isUnlimited(plan, kind)) return null;

  const cap = override ?? Number(
    plan![kind === "channels" ? "max_channels"
        : kind === "renders_day" ? "max_renders_day"
        : "max_renders_month"] as number);
  const cacheKey = `${tenant.userId}|${kind}`;
  const cached = _cache.get(cacheKey);
  let used: number;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    used = cached.used;
  } else {
    used = kind === "channels"
      ? await _countChannels(tenant.userId)
      : kind === "renders_day"
      ? await _countRendersToday(tenant.userId)
      : await _countRendersThisMonth(tenant.userId);
    _cache.set(cacheKey, { at: Date.now(), used });
  }

  if (used >= cap) {
    return NextResponse.json({
      // Say "trial" when the cap came from an override, not "plan" —
      // telling a trial user their PLAN allows 1 video/day sends them
      // to a billing page that will not explain it.
      error: kind === "channels"
        ? `channel limit reached — your ${override ? "trial" : "plan"} allows ${cap} channel(s), you have ${used}`
        : kind === "renders_day"
        ? `daily video limit reached — your ${override ? "trial" : "plan"} allows ${cap} video(s)/day. Request more from your dashboard.`
        : `monthly render limit reached — your plan allows ${cap} render(s)/month, you have ${used}`,
      quota_kind: kind, cap, used,
    }, { status: 429 });
  }
  return null;
}

/** Invalidate the cache after a successful create so the next check
 *  reflects the new count. Call from POST handlers right after write. */
export function bustQuotaCache(userId: string, kind?: QuotaKind): void {
  if (!kind) {
    for (const k of _cache.keys()) if (k.startsWith(`${userId}|`)) _cache.delete(k);
  } else {
    _cache.delete(`${userId}|${kind}`);
  }
}

export type QuotaStatus = {
  channels: { used: number; limit: number | null };
  videosToday: { used: number; limit: number | null };
  trial: { active: boolean; expiresAt: number; daysLeft: number; daysGranted: number };
  enforced: boolean;
};

/**
 * Everything the dashboard needs to show a user where they stand.
 *
 * `limit: null` means uncapped — either the plan is unlimited or
 * enforcement is off. The UI must render that as "unlimited" rather
 * than as 0, which would read as "you may do nothing".
 *
 * Reports the limit that would ACTUALLY apply, override included, so
 * the number here matches the number the guard enforces. Two different
 * resolutions for the same question is how a dashboard ends up
 * confidently contradicting the error message a user just saw.
 */
export async function quotaStatus(userId: string): Promise<QuotaStatus> {
  const enforced = await getFlag("quotas_enforced");

  const [chOverride, vdOverride] = await Promise.all([
    _userOverride(userId, "channels"),
    _userOverride(userId, "renders_day"),
  ]);
  const plan = await _resolvePlan(userId);

  const chPlan = _isUnlimited(plan, "channels")
    ? null : Number(plan!.max_channels as number);
  const vdPlan = _isUnlimited(plan, "renders_day")
    ? null : Number(plan!.max_renders_day as number);

  const [chUsed, vdUsed] = await Promise.all([
    _countChannels(userId),
    _countRendersToday(userId),
  ]);

  let trialExpiresAt = 0, trialDaysGranted = 0;
  try {
    const u = await adminDb().collection("app_users").doc(userId).get();
    if (u.exists) {
      const d = (u.data() || {}) as Record<string, unknown>;
      trialExpiresAt = Number(d.trial_expires_at || 0) || 0;
      trialDaysGranted = Number(d.trial_days_granted || 0) || 0;
    }
  } catch { /* status still useful without it */ }

  const now = Math.floor(Date.now() / 1000);
  return {
    channels: { used: chUsed, limit: chOverride ?? chPlan },
    videosToday: { used: vdUsed, limit: vdOverride ?? vdPlan },
    trial: {
      active: trialExpiresAt > now,
      expiresAt: trialExpiresAt,
      daysLeft: trialExpiresAt > now ? Math.ceil((trialExpiresAt - now) / 86400) : 0,
      daysGranted: trialDaysGranted,
    },
    enforced,
  };
}
