import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireMaintenanceKey } from "@/app/api/_lib/auth";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { sweepNiche, readIntel, bestHours, topTags } from "@/lib/niche-intel";
import { withHeartbeat } from "@/lib/maintenance-heartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/maintenance/niche-intel
 *
 * Daily read of what is currently working in each niche the platform
 * actually renders for.
 *
 * The YouTube key was previously doing two narrow jobs — three
 * competitor titles at script time and view counts afterwards — using
 * roughly 1,700 of a 10,000/day quota. This spends a deliberate slice
 * of the remainder on the question that actually drives results: what
 * is ranking in this niche right now, which tags do the winners share,
 * and when do they publish.
 *
 * Cost is ~101 units per niche (search.list is 100 and returns 50 ids;
 * videos.list then returns stats AND tags for all 50 for 1 unit), so
 * the sweep is bounded by MAX_NICHES to keep a hard ceiling on spend.
 *
 * Findings MERGE into the stored row. One day of 50 videos cannot
 * establish which hour a niche performs best; weeks of pooled counts
 * can. Sample sizes are stored and surfaced so nothing downstream
 * mistakes a thin reading for a settled one.
 */

/** Hard quota ceiling: 8 niches x ~101 units = ~808/day, comfortably
 *  inside 10,000 alongside per-render lookups and the stats sweep. */
const MAX_NICHES = 8;

async function _handler(req: NextRequest) {
  const auth = await requireMaintenanceKey(req);
  if (auth !== true) return auth;

  const reqId = newRequestId();
  const url = new URL(req.url);
  const only = (url.searchParams.get("niche") || "").trim();

  try {
    // Sweep only niches the platform actually renders for — paying 101
    // units to研究 a niche nobody publishes to is pure waste.
    const niches = new Set<string>();
    if (only) {
      niches.add(only);
    } else {
      const snap = await adminDb().collection("channels").limit(200).get();
      snap.forEach((d) => {
        const c = (d.data() || {}) as Record<string, unknown>;
        if (c.enabled === false) return;
        const n = String(c.niche || "").trim().toLowerCase();
        if (n) niches.add(n);
      });
    }

    const list = [...niches].slice(0, MAX_NICHES);
    if (list.length === 0) {
      logRoute(reqId, "niche-intel: no active niches");
      return NextResponse.json({ ok: true, swept: 0, niches: [] });
    }

    const results: Array<{ niche: string; observed: number; sample: number; hours: unknown; tags: number }> = [];
    let quotaUnits = 0;

    for (const n of list) {
      const observed = await sweepNiche(n);
      quotaUnits += observed > 0 ? 101 : 100;   // the search is spent either way
      const intel = await readIntel(n);
      results.push({
        niche: n,
        observed,
        sample: intel.sampleSize,
        // null until the evidence supports a recommendation
        hours: bestHours(intel),
        tags: topTags(intel).length,
      });
    }

    const learned = results.reduce((a, r) => a + r.observed, 0);
    logRoute(reqId, "niche-intel sweep", { niches: list.length, learned, quota_units: quotaUnits });

    if (learned === 0) {
      // Say so rather than reporting a successful sweep that learned
      // nothing — missing key or exhausted quota both land here.
      return NextResponse.json({
        ok: false, swept: list.length, learned: 0,
        error: "No data returned — YOUTUBE_API_KEY missing, or daily quota exhausted.",
      });
    }

    return NextResponse.json({
      ok: true,
      swept: list.length,
      learned,
      quota_units: quotaUnits,
      niches: results,
    });
  } catch (e) {
    logRoute(reqId, "niche-intel failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export const POST = withHeartbeat("niche-intel", _handler);
