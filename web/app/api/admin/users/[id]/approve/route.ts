import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { markJoinedAndCheckUnlock, getOrCreateReferral } from "@/lib/referrals";
import { grantEarnedRewards, grantTrialFromReferrals } from "@/lib/referral-rewards";

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
    let trialGrant: Awaited<ReturnType<typeof grantTrialFromReferrals>> = null;
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
        // Trial time and quotas, which the tier table does not cover.
        // Open-ended by design: 5 approved referrals unlock 7 days and
        // every further 4 add 7 more, so it is computed rather than
        // looked up. Idempotent against trial_days_granted, so a
        // re-approval owes nothing.
        trialGrant = await grantTrialFromReferrals(
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
      trial_grant: trialGrant || undefined,
      },
    }, req);

    // Tell them. Approval was silent: the account flipped to active and
    // the person who signed up had no way to know except by trying to
    // log in again on a hunch. For a product where approval is manual
    // and can take hours, that is the difference between a customer and
    // someone who assumed they were rejected.
    //
    // Best-effort by design — a mail failure must never undo an
    // approval that already succeeded in the database.
    try {
      if (d.email) {
        const { sendMail, mailerConfigured } = await import("@/lib/mailer");
        if (await mailerConfigured()) {
          const trialLine = trialGrant
            ? `

Your referral trial is active: ${trialGrant.added_days} day(s) added, `
              + `running until ${new Date(trialGrant.expires_at * 1000).toDateString()}.`
            : "";
          await sendMail({
            to: String(d.email),
            subject: "Your Yven account is approved",
            text:
              `You're in.

`
              + `Your Yven account has been approved — you can sign in and connect a `
              + `channel now.

https://yven.io/login${trialLine}

`
              + `Reply to this email if anything looks wrong.`,
            html:
              `<p><strong>You're in.</strong></p>`
              + `<p>Your Yven account has been approved — you can sign in and connect a channel now.</p>`
              + `<p><a href="https://yven.io/login">Sign in to Yven</a></p>`
              + (trialGrant
                  ? `<p>Your referral trial is active: <strong>${trialGrant.added_days} day(s)</strong> added, `
                    + `running until ${new Date(trialGrant.expires_at * 1000).toDateString()}.</p>`
                  : "")
              + `<p style="color:#666;font-size:13px">Reply to this email if anything looks wrong.</p>`,
          });
        }
      }
    } catch (e) {
      console.error("approval email failed (account is still approved):", e);
    }

    return NextResponse.json({
      ok: true, id, status: "active",
      referral: referralUnlocked || undefined,
      referral_reward: referralReward?.granted?.length ? referralReward : undefined,
      trial_grant: trialGrant || undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
