import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";
import { requireTenant } from "@/lib/tenant";

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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  // Shutting down a worker is an operator action — admin+ only.
  // Free-tier users can't kill your Kaggle box, and one user can't
  // kill another user's personal worker (would also be blocked by
  // owner check below, but role gate is a cheap first line).
  if (auth.tenant.role !== "admin" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "admin role required to shut down workers" }, { status: 403 });
  }
  try {
    const snap = await adminDb().collection("backends").doc(id).get();
    if (!snap.exists) {
      // Already gone — treat as success (idempotent).
      return NextResponse.json({ ok: true, note: "backend doc already absent" });
    }
    const data = snap.data() as { url?: string; last_seen_at?: unknown; last_seen?: unknown; owner_user_id?: string };
    // Ownership guard (only under enforcement): non-superadmin admins
    // can only shut down workers they own OR shared-pool workers.
    if (auth.tenant.enforce && auth.tenant.role !== "superadmin") {
      const owner = String(data.owner_user_id || "");
      if (owner && owner !== auth.tenant.userId) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
    }
    const url = data.url || "";

    if (!url) {
      // Outbound-poll worker.
      //
      // BEFORE: we tried to be graceful — set shutdown_pending and hope
      // the worker's next heartbeat/claim response echo made it back
      // through and the worker self-terminated. That was ONE too many
      // failure modes: response can be dropped, worker can be on old
      // code (pre-SIGKILL), Kaggle can freeze the kernel mid-download,
      // network can hiccup. Users saw 'Terminate' as unreliable.
      //
      // NOW: forceful, always. Do all three in order, none blocks the
      // return:
      //   1. Set shutdown_pending + shutdown_requested_at so a healthy
      //      worker CAN self-exit cleanly (releases GPU sooner + logs
      //      cleanly). Best case: worker dies within one heartbeat.
      //   2. Immediately mark the active_job_id as failed (if any) so
      //      the queue doesn't show a phantom running job.
      //   3. Delete the backends row itself. The card disappears from
      //      Monitor instantly. If the worker is on old code and never
      //      sees the flag, the Kaggle/Colab free-tier watchdog will
      //      eventually kill the kernel; meanwhile the dashboard is
      //      clean.
      const activeJobId = String((data as { active_job_id?: string }).active_job_id || "");
      // DO NOT delete the row. If we delete it, the worker's next
      // heartbeat (5-30 s later) hits /api/workers/register and creates
      // a fresh row with shutdown_pending=false — Terminate becomes a
      // no-op on zombie workers. Instead we FLAG the row; the register
      // route now short-circuits on shutdown_pending and refuses to
      // refresh last_seen_at, so the row goes stale and the Monitor's
      // 3-min freshness filter hides it. A NEW-code worker sees
      // shutdown:true in the response and SIGKILLs itself immediately.
      try {
        await adminDb().collection("backends").doc(id).update({
          shutdown_pending:       true,
          shutdown_requested_at:  Date.now() / 1000,
          status:                 "terminating",
        });
      } catch { /* best-effort */ }

      if (activeJobId) {
        try {
          await adminDb().collection("jobs").doc(activeJobId).update({
            status:      "failed",
            error:       "worker terminated from dashboard",
            finished_at: Date.now() / 1000,
          });
        } catch { /* best-effort */ }
      }

      return NextResponse.json({
        ok: true,
        mode: "outbound_poll_forced",
        active_job_failed: !!activeJobId,
        note: "shutdown flagged + active job failed; row stays but the register " +
              "route refuses to refresh it, so the Monitor freshness filter " +
              "(~3 min) hides the card and the cleanup-stale cron deletes " +
              "the tombstone.",
      });
    }

    // Inbound-URL worker — delete registry entry so the card
    // disappears instantly, then best-effort POST /api/shutdown.
    const activeJobId2 = String((data as { active_job_id?: string }).active_job_id || "");
    try {
      await adminDb().collection("backends").doc(id).delete();
    } catch (e) {
      console.error("backends doc delete failed:", e);
    }
    if (activeJobId2) {
      try {
        await adminDb().collection("jobs").doc(activeJobId2).update({
          status: "failed",
          error: "worker terminated from dashboard",
          finished_at: Date.now() / 1000,
        });
      } catch { /* best-effort */ }
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
