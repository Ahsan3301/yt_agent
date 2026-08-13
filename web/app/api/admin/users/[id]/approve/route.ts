import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { markJoinedAndCheckUnlock, getOrCreateReferral } from "@/lib/referrals";
import { grantEarnedRewards } from "@/lib/referral-rewards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/admin/users/[id]/approve
 *
 * Admin+ only. Flips app_users.<id>.status from "pending" -> "active",
 * assigns plans/free by default (superadmin can reassign later via the
 * plan route). Idempotent — approving an already-active user is a no-op.
 * Logs to audit_log.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "admin" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const ref = adminDb().collection("app_users").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return NextResponse.json({ error: "user not found" }, { status: 404 });
    const d = doc.data() as Record<string, unknown>;
    if (d.status === "active") {
      return NextResponse.json({ ok: true, note: "already active" });
    }
    const now = Math.floor(Date.now() / 1000);
    await ref.set({
      status: "active",
      plan_id: d.plan_id || "free",
      approved_by: auth.tenant.userId,
      approved_at: now,
    }, { merge: true });
    // Give the freshly-approved user their own referral code so they
    // can invite others. Idempotent — safe if a code already exists.
    let referralUnlocked: null | { referrerUserId: string; joinedCount: number; newlyUnlocked: boolean } = null;
    let referralReward: Awaited<ReturnType<typeof grantEarnedRewards>> | null = null;
    try {
      await getOrCreateReferral(id);
      // If this user was themselves referred, flip that signup to
      // "joined" and check whether their referrer just crossed 5.
      referralUnlocked = await markJoinedAndCheckUnlock(id);

      // Approval IS the qualifying event — "approved referrals" in the
      // reward terms means exactly this transition, so the payout
      // belongs here rather than on a nightly sweep that would leave
      // people waiting a day for something they have already earned.
      //
      // Pays every unpaid tier at once: someone who brings ten friends
      // before anyone is approved should collect both the 5 and the 10
      // reward, not just the highest.
      if (referralUnlocked?.referrerUserId) {
        referralReward = await grantEarnedRewards(
          referralUnlocked.referrerUserId,
          referralUnlocked.joinedCount,
        );
      }
    } catch (e) {
      // Referral tracking is best-effort — never blocks user approval.
      console.error("referral bookkeeping failed:", e);
    }

    await audit(auth.tenant, {
      action: "user.approve",
      target_type: "app_users",
      target_id: id,
      meta: {
        email: d.email,
        previous_status: d.status || "pending",
        referral: referralUnlocked || undefined,
        referral_reward: referralReward?.granted?.length ? referralReward : undefined,
      },
    }, req);

    return NextResponse.json({
      ok: true, id, status: "active",
      referral: referralUnlocked || undefined,
      referral_reward: referralReward?.granted?.length ? referralReward : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
