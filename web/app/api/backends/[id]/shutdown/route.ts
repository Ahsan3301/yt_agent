import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

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
    const data = snap.data() as { url?: string };
    const url = data.url || "";

    if (!url) {
      // Outbound-poll worker — no reachable URL. Flip status to
      // 'shutdown_requested'; the worker's next /api/jobs/claim
      // poll (≤5s) sees the flag and os._exit(0). Keep the doc
      // around so the poll returns a definite {shutdown: true}
      // instead of 404. The worker will vanish from the registry
      // after the heartbeat freshness window (or when we delete
      // it below on the next click).
      try {
        await adminDb().collection("backends").doc(id).update({
          status: "shutdown_requested",
        });
        return NextResponse.json({
          ok: true,
          mode: "outbound_poll",
          note: "shutdown flag set; worker will exit on next claim poll (≤5 s)",
        });
      } catch (e) {
        // Fall through — best-effort delete instead.
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
