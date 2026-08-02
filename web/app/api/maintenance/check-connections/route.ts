import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { checkAccounts } from "@/lib/youtube-health";
import { getConfig } from "@/lib/platform-config";
import { withHeartbeat } from "@/lib/maintenance-heartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/check-connections
 *
 * Scheduled sweep over every tenant's connected YouTube accounts.
 *
 * Why this runs on a timer rather than on demand: a revoked token
 * produces no event. Without polling, the platform only discovers the
 * problem when a render has already spent ~20 minutes of GPU and
 * fails at the upload step — and historically only the operator ever
 * saw that, in a Discord message. A daily probe means a customer is
 * told their channel needs reconnecting before it costs them a video.
 *
 * Alerts fire only on TRANSITIONS into a broken state, so a channel
 * that stays disconnected doesn't generate a message every single day.
 */
async function _handler(req: NextRequest) {
  // Returns `true` when authorised, or a Response to send back.
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  try {
    // Snapshot prior state so we can report only what changed.
    const before = new Map<string, string>();
    const prev = await adminDb().collection("youtube_accounts").limit(200).get();
    prev.forEach((d) => {
      const x = (d.data() || {}) as Record<string, unknown>;
      before.set(d.id, String(x.health_status || "unknown"));
    });

    const results = await checkAccounts({});   // all tenants

    const newlyBroken = results.filter(
      (r) => r.status !== "ok" && before.get(r.id) === "ok",
    );
    const recovered = results.filter(
      (r) => r.status === "ok" && (before.get(r.id) === "dead" || before.get(r.id) === "error"),
    );
    const stillBroken = results.filter(
      (r) => r.status !== "ok" && before.get(r.id) !== "ok",
    );

    logRoute(reqId, "connection sweep", {
      checked: results.length,
      newly_broken: newlyBroken.length,
      recovered: recovered.length,
      still_broken: stillBroken.length,
    });

    if (newlyBroken.length > 0) {
      await _alertAsync(newlyBroken.map((r) => `${r.title} — ${r.error}`));
    }

    return NextResponse.json({
      ok: true,
      checked: results.length,
      newly_broken: newlyBroken.map((r) => ({ title: r.title, error: r.error })),
      recovered: recovered.map((r) => r.title),
      still_broken: stillBroken.map((r) => r.title),
    });
  } catch (e) {
    logRoute(reqId, "connection sweep failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** Best-effort operator ping. Never throws. */
async function _alertAsync(lines: string[]): Promise<void> {
  try {
    const hook = await getConfig("DISCORD_WEBHOOK_URL");
    if (!hook) return;
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "🔌 YouTube channel disconnected",
          description:
            "These channels stopped working since the last check and " +
            "will fail at the publish step until reconnected:\n\n" +
            lines.map((l) => `• ${l}`).join("\n"),
          color: 0xef4444,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch { /* silent */ }
}

// Heartbeat wrapper: records that this job ran, and what it did,
// so a job that silently stops shows up as stale on the health page.
export const POST = withHeartbeat("check-connections", _handler);
