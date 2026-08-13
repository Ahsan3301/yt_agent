import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { getReferralStatsFor } from "@/lib/referrals";
import { REWARD_TIERS, getRewardHistory, nextTier } from "@/lib/referral-rewards";
import { publicOrigin } from "@/app/api/_lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/referrals/me
 *
 * The caller's referral code, progress, and — the part that was missing
 * — what they have actually been GIVEN. The page previously showed a
 * progress ring against a threshold and then told the user to ask an
 * operator for their reward, because nothing in the system granted one.
 *
 * Tier definitions are returned rather than hardcoded in the page, so
 * changing the offer is a one-line edit in lib/referral-rewards.ts and
 * the UI follows.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;

  try {
    const userId = auth.tenant.userId;
    const stats = await getReferralStatsFor(userId);
    const origin = publicOrigin(req);
    const joined = Number(stats.joined_count || 0);

    const rewards = await getRewardHistory(userId);

    // Current entitlement, so the page can say "your plan is active
    // until X" rather than implying a reward that expired is still live.
    let planId = "free";
    let planExpiresAt = 0;
    try {
      const u = await adminDb().collection("app_users").doc(userId).get();
      if (u.exists) {
        const d = (u.data() || {}) as Record<string, unknown>;
        planId = String(d.plan_id || "free");
        planExpiresAt = Number(d.plan_expires_at || 0) || 0;
      }
    } catch { /* fall through with defaults */ }

    const next = nextTier(joined);

    return NextResponse.json({
      ...stats,
      share_url: `${origin}${stats.share_url_path}`,

      tiers: REWARD_TIERS.map((t) => ({
        at: t.at,
        days: t.days,
        label: t.label,
        earned: joined >= t.at,
        // A tier can be earned but unpaid if the grant failed — surface
        // that instead of quietly showing it as complete.
        granted: rewards.some((r) => r.tier === t.at),
      })),
      next_tier: next ? { at: next.at, days: next.days, label: next.label,
                          remaining: Math.max(0, next.at - joined) } : null,
      rewards,
      total_days_granted: rewards.reduce((s, r) => s + (r.days_granted || 0), 0),
      plan: { id: planId, expires_at: planExpiresAt },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
