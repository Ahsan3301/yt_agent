import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/backends/[id]/shutdown
 *
 * Tell the named worker to terminate itself. Used by the dashboard's
 * Monitor card "Terminate" button — most useful for Kaggle, which
 * otherwise stays alive for ~10 min of idle before auto-shutting.
 *
 * Looks up the worker's URL in Firestore `backends/<id>`, then POSTs
 * to its `/api/shutdown`. The worker schedules an os._exit(0) on a
 * 1-sec delay so this HTTP call gets to return.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const snap = await adminDb().collection("backends").doc(id).get();
    if (!snap.exists) {
      // Already gone — treat as success (idempotent).
      return NextResponse.json({ ok: true, note: "backend doc already absent" });
    }
    const data = snap.data() as { url?: string; last_seen_at?: unknown; last_seen?: unknown };
    const url = data.url || "";

    if (!url) {
      // Outbound-poll worker. Two sub-cases:
      //  1. Worker is ALIVE (fresh heartbeat) → set shutdown_pending
      //     (a SEPARATE field the heartbeat register route does NOT
      //     overwrite). Worker sees it on its next claim/heartbeat
      //     and os._exit(0)s.
      //  2. Worker is DEAD (no heartbeat in >90s) → delete the corpse.
      const lastMs = toEpochMs(data.last_seen_at ?? data.last_seen) || 0;
      const alive = lastMs > 0 && (Date.now() - lastMs) < 90_000;
      try {
        if (alive) {
          await adminDb().collection("backends").doc(id).update({
            shutdown_pending: true,
          });
          return NextResponse.json({
            ok: true,
            mode: "outbound_poll_alive",
            note: "shutdown flag set; worker exits on next claim/heartbeat (≤5 s)",
          });
        } else {
          await adminDb().collection("backends").doc(id).delete();
          return NextResponse.json({
            ok: true,
            mode: "outbound_poll_dead",
            note: "corpse card removed",
          });
        }
      } catch (e) {
        try { await adminDb().collection("backends").doc(id).delete(); } catch {}
        return NextResponse.json({ ok: true, note: String(e) });
      }
    }

    // Inbound-URL worker — delete registry entry so the card
    // disappears instantly, then best-effort POST /api/shutdown.
    try {
      await adminDb().collection("backends").doc(id).delete();
    } catch (e) {
      console.error("backends doc delete failed:", e);
    }

    // Now best-effort tell the worker to exit. Don't await long —
    // the worker schedules os._exit(0) on a 1-sec delay so its
    // response might race with the kill. Either outcome is fine
    // (we've already removed the registry entry).
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/api/shutdown`, {
        method: "POST",
        headers: { "X-Vercel-Gateway": "1" },
        // Cap at 4 seconds — if the worker takes longer it's probably
        // already dying.
        signal: AbortSignal.timeout(4000),
      });
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        return NextResponse.json({ ok: true, worker: body, removed_from_registry: true });
      }
      return NextResponse.json({
        ok: true,
        worker_status: r.status,
        removed_from_registry: true,
        note: "worker did not respond cleanly but registry was cleared",
      });
    } catch (e) {
      return NextResponse.json({
        ok: true,
        worker_error: String(e),
        removed_from_registry: true,
        note: "worker unreachable but registry was cleared",
      });
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
