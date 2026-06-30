import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Tiny cache so a dashboard with the page open doesn't hammer Firestore.
// 15s is short enough to feel live, long enough to absorb multi-tab polling.
const _CACHE_TTL_MS = 15_000;
let _cached: { at: number; body: unknown } | null = null;

/**
 * GET /api/health/summary
 *
 * Aggregator for the /health dashboard page. One call, all the
 * pieces a status surface needs:
 *
 *   {
 *     ts: number,
 *     workers: { online, gpu_alive, any_alive, cards: [...] },
 *     jobs:    { last_24h: {total, complete, failed, cancelled, running, queued}, success_rate },
 *     errors:  [...]  // last 10
 *     storage: { runs_index_count, run_summaries_count, jobs_count, errors_count }
 *   }
 *
 * Cached server-side for 15 sec.
 */
export async function GET() {
  if (_cached && Date.now() - _cached.at < _CACHE_TTL_MS) {
    return NextResponse.json(_cached.body, {
      headers: { "X-Cache": "HIT", "Cache-Control": "no-store" },
    });
  }

  try {
    const db = adminDb();
    const now = Date.now() / 1000;
    const cutoff90s = now - 90;
    const cutoff24h = now - 86400;

    // Workers — read backends + filter by freshness. The schema uses
    // `last_seen_at` but legacy registry.py writes `last_seen`; accept
    // either so both code paths render.
    const workersSnap = await db.collection("backends").limit(50).get();
    let online = 0;
    let gpu_alive = false;
    let any_alive = false;
    const cards: Array<Record<string, unknown>> = [];
    workersSnap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const lastEpochMs = toEpochMs(d.last_seen_at ?? d.last_seen);
      const lastEpoch = lastEpochMs ? lastEpochMs / 1000 : 0;
      const alive = lastEpoch >= cutoff90s;
      if (alive) {
        online += 1;
        any_alive = true;
        if (d.tier === "gpu") gpu_alive = true;
      }
      cards.push({
        instance_id: doc.id,
        label:       d.label || null,
        tier:        d.tier || "unknown",
        status:      d.status || "unknown",
        gpu_name:    d.gpu_name || null,
        url:         d.url || null,
        last_seen:   lastEpoch,
        started_at:  d.started_at || null,
        alive,
      });
    });

    // Jobs in the last 24h.
    let total24h = 0;
    const byStatus: Record<string, number> = {};
    try {
      const snap = await db.collection("jobs")
        .where("queued_at", ">", cutoff24h)
        .orderBy("queued_at", "desc")
        .limit(500)
        .get();
      snap.forEach((doc) => {
        total24h += 1;
        const s = String((doc.data() as Record<string, unknown>).status || "unknown");
        byStatus[s] = (byStatus[s] || 0) + 1;
      });
    } catch {
      // The composite index may not exist yet on a fresh deploy.
      // Fall back to no-filter scan, capped low.
      const snap = await db.collection("jobs").limit(200).get();
      snap.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        const q = Number(d.queued_at || 0);
        if (q > cutoff24h) {
          total24h += 1;
          const s = String(d.status || "unknown");
          byStatus[s] = (byStatus[s] || 0) + 1;
        }
      });
    }
    const complete = byStatus["complete"] || 0;
    const failed = byStatus["failed"] || 0;
    const totalTerminal = complete + failed + (byStatus["cancelled"] || 0);
    const success_rate = totalTerminal > 0 ? complete / totalTerminal : null;

    // Last 10 errors.
    let errors: Array<Record<string, unknown>> = [];
    try {
      const snap = await db.collection("errors")
        .orderBy("ts", "desc")
        .limit(10)
        .get();
      errors = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    } catch {
      // collection may not exist yet on a fresh deploy
      errors = [];
    }

    // Counts (rough quota indicators — Firestore exposes no direct
    // metric and counting all docs is expensive. We count what's cheap
    // and call it good.).
    let runs_index_count = 0;
    let jobs_count = 0;
    let errors_count = 0;
    try {
      const a = await db.collection("runs_index").count().get();
      runs_index_count = a.data().count;
    } catch { /* count() may not be available */ }
    try {
      const a = await db.collection("jobs").count().get();
      jobs_count = a.data().count;
    } catch { /* noop */ }
    try {
      const a = await db.collection("errors").count().get();
      errors_count = a.data().count;
    } catch { /* noop */ }

    const body = {
      ts: now,
      workers: {
        online,
        gpu_alive,
        any_alive,
        cards: cards.sort((a, b) => Number(b.last_seen) - Number(a.last_seen)),
      },
      jobs: {
        last_24h: {
          total: total24h,
          ...byStatus,
        },
        success_rate,
      },
      errors,
      storage: {
        runs_index_count,
        jobs_count,
        errors_count,
      },
    };
    _cached = { at: Date.now(), body };
    return NextResponse.json(body, {
      headers: { "X-Cache": "MISS", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e), next_step: "Check Firestore configuration on Vercel." },
      { status: 500 },
    );
  }
}
