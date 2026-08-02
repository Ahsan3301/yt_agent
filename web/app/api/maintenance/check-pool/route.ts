import { NextRequest, NextResponse } from "next/server";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { checkPool, readPoolHealth } from "@/lib/pool-health";
import { getConfig } from "@/lib/platform-config";
import { withHeartbeat } from "@/lib/maintenance-heartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/check-pool
 *
 * Scheduled probe of the shared credential pool.
 *
 * This matters more than the per-tenant connection sweep: every
 * customer's renders now run on these keys, so one expiring takes the
 * whole platform down at once — and an expired API key produces no
 * event, the provider simply starts returning 401 mid-render.
 *
 * Alerts fire only on transitions into a broken state, so a key that
 * stays broken doesn't generate a message every hour.
 */
async function _handler(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  try {
    const before = new Map(
      (await readPoolHealth()).items.map((i) => [i.key, i.status]),
    );
    const now = await checkPool(true);

    const newlyBroken = now.items.filter(
      (i) => i.status === "bad" && before.get(i.key) !== "bad",
    );
    const degraded = now.items.filter(
      (i) => i.status === "error" && before.get(i.key) === "ok",
    );
    const recovered = now.items.filter(
      (i) => i.status === "ok" && (before.get(i.key) === "bad" || before.get(i.key) === "error"),
    );

    logRoute(reqId, "pool health sweep", {
      checked: now.items.length,
      broken: now.broken,
      newly_broken: newlyBroken.length,
      degraded: degraded.length,
      recovered: recovered.length,
    });

    if (newlyBroken.length > 0 || degraded.length > 0) {
      await _alertAsync(newlyBroken, degraded);
    }

    return NextResponse.json({
      ok: true,
      checked: now.items.length,
      broken: now.broken,
      newly_broken: newlyBroken.map((i) => i.key),
      degraded: degraded.map((i) => i.key),
      recovered: recovered.map((i) => i.key),
    });
  } catch (e) {
    logRoute(reqId, "pool health sweep failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

async function _alertAsync(
  broken: Array<{ key: string; detail: string }>,
  degraded: Array<{ key: string; detail: string }>,
): Promise<void> {
  try {
    const hook = await getConfig("DISCORD_WEBHOOK_URL");
    if (!hook) return;
    const lines: string[] = [];
    if (broken.length) {
      lines.push("**Broken — affects every customer:**");
      broken.forEach((i) => lines.push(`• \`${i.key}\` — ${i.detail}`));
    }
    if (degraded.length) {
      if (lines.length) lines.push("");
      lines.push("**Degraded:**");
      degraded.forEach((i) => lines.push(`• \`${i.key}\` — ${i.detail}`));
    }
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "🔑 Shared credential problem",
          description:
            lines.join("\n") +
            "\n\nFix at Superadmin → Key pool. Renders will keep failing until then.",
          color: broken.length ? 0xef4444 : 0xfbbf24,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch { /* silent */ }
}

// Heartbeat wrapper: records that this job ran, and what it did,
// so a job that silently stops shows up as stale on the health page.
export const POST = withHeartbeat("check-pool", _handler);
