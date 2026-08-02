import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { bustQuotaCache } from "@/lib/quota";
import { getConfig } from "@/lib/platform-config";
import { withHeartbeat } from "@/lib/maintenance-heartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/check-subscriptions
 *
 * Daily subscription sweep for manual billing.
 *
 * Payments are taken outside the product, so nothing tells the
 * platform a subscription ended. Two jobs here:
 *
 *   1. Downgrade anyone whose paid term has passed. Quota resolution
 *      already treats an expired plan as free at read time, so access
 *      is correct even between sweeps — this makes the stored record
 *      match reality, so the admin list doesn't show someone as "Pro"
 *      when they're being metered as free.
 *
 *   2. Tell the operator who is about to lapse. With no payment
 *      provider sending dunning emails, an expiry that passes
 *      unnoticed is either an unbilled customer or an unhappy one.
 */
const WARN_WINDOW_DAYS = 7;

async function _handler(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  const now = Math.floor(Date.now() / 1000);
  const warnCutoff = now + WARN_WINDOW_DAYS * 86400;

  try {
    const snap = await adminDb().collection("app_users").limit(500).get();
    const downgraded: Array<{ email: string; was: string }> = [];
    const expiringSoon: Array<{ email: string; plan: string; days: number }> = [];

    for (const doc of snap.docs) {
      const d = (doc.data() || {}) as Record<string, unknown>;
      const expires = Number(d.plan_expires_at || 0);
      const plan = String(d.plan_id || "");
      if (!expires || plan === "free" || plan === "founder") continue;

      if (expires < now) {
        await doc.ref.set({
          plan_id: "free",
          plan_expires_at: 0,
          // Keep the note — it's the only record of what they paid.
          plan_note: `${String(d.plan_note || "")} [auto-downgraded from ${plan}]`.trim().slice(0, 300),
        }, { merge: true });
        bustQuotaCache(doc.id);
        downgraded.push({ email: String(d.email || doc.id), was: plan });
      } else if (expires < warnCutoff) {
        expiringSoon.push({
          email: String(d.email || doc.id),
          plan,
          days: Math.max(0, Math.ceil((expires - now) / 86400)),
        });
      }
    }

    logRoute(reqId, "subscription sweep", {
      downgraded: downgraded.length, expiring_soon: expiringSoon.length,
    });

    if (downgraded.length || expiringSoon.length) {
      await _alertAsync(downgraded, expiringSoon);
    }

    return NextResponse.json({ ok: true, downgraded, expiring_soon: expiringSoon });
  } catch (e) {
    logRoute(reqId, "subscription sweep failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

async function _alertAsync(
  downgraded: Array<{ email: string; was: string }>,
  soon: Array<{ email: string; plan: string; days: number }>,
): Promise<void> {
  try {
    const hook = await getConfig("DISCORD_WEBHOOK_URL");
    if (!hook) return;
    const lines: string[] = [];
    if (downgraded.length) {
      lines.push("**Lapsed — now on Free:**");
      downgraded.forEach((u) => lines.push(`• ${u.email} (was ${u.was})`));
    }
    if (soon.length) {
      if (lines.length) lines.push("");
      lines.push(`**Expiring within ${WARN_WINDOW_DAYS} days:**`);
      soon.forEach((u) => lines.push(`• ${u.email} — ${u.plan}, ${u.days}d left`));
    }
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "💳 Subscription status",
          description: lines.join("\n") + "\n\nRenew at Admin → Users after payment clears.",
          color: downgraded.length ? 0xef4444 : 0xfbbf24,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch { /* silent */ }
}

// Heartbeat wrapper: records that this job ran, and what it did,
// so a job that silently stops shows up as stale on the health page.
export const POST = withHeartbeat("check-subscriptions", _handler);
