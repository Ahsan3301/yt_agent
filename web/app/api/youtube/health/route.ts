import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant, tenantWhereClauses } from "@/lib/tenant";
import { checkAccounts } from "@/lib/youtube-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET  /api/youtube/health  — last known status of the caller's
 *                             connected channels. Cheap; no network.
 * POST /api/youtube/health  — re-probe them against Google now.
 *
 * Split deliberately: the channels page reads the stored status on
 * every load (fast, free), and only performs the live check when the
 * user asks or the background sweep runs. Probing Google on every page
 * render would be slow and would burn quota for no benefit.
 */

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    let q = adminDb().collection("youtube_accounts").limit(200);
    for (const [f, op, v] of tenantWhereClauses(auth.tenant)) q = q.where(f, op, v);
    const snap = await q.get();

    const items = snap.docs.map((d) => {
      const x = (d.data() || {}) as Record<string, unknown>;
      return {
        id: d.id,
        title: String(x.title || "(unnamed)"),
        // Never checked yet reads as "unknown" rather than implying
        // health we haven't verified.
        status: String(x.health_status || "unknown"),
        error: String(x.health_error || ""),
        checked_at: Number(x.health_checked_at || 0),
      };
    });

    return NextResponse.json({
      items,
      broken: items.filter((i) => i.status === "dead" || i.status === "error").length,
      unchecked: items.filter((i) => i.status === "unknown").length,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    // Superadmin re-checks everything; a normal user only their own.
    const results = await checkAccounts(
      auth.tenant.isSuper ? {} : { userId: auth.tenant.userId },
    );
    return NextResponse.json({
      items: results,
      broken: results.filter((r) => r.status !== "ok").length,
      checked: results.length,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
