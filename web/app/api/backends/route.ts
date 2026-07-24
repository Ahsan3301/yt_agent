import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/backends
 *
 * Return every registered backend (worker), regardless of whether it
 * has an inbound URL. Outbound-poll workers (Kaggle/Colab in Coolify
 * mode) intentionally have `url=""` — they still show up here so the
 * Monitor + LaunchBanner can render a card and mark them alive/dead
 * by heartbeat age.
 *
 * Response shape matches RegistryEntry consumed by web/lib/api.ts.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const { tenant } = auth;
  try {
    // Build the doc list. When tenant filtering is enforced AND the
    // caller isn't a superadmin, they see: (a) workers they OWN
    // (owner_user_id == userId) PLUS (b) shared-pool workers
    // (tier_scope == "shared"). Shared visibility is deliberate —
    // knowing the shared queue is busy is useful UX even for users
    // who can't claim on it. Two parallel queries + dedupe by id.
    const collectDocs = async (): Promise<Array<{ id: string; data: () => Record<string, unknown> }>> => {
      if (!tenant.enforce) {
        const snap = await adminDb().collection("backends").limit(100).get();
        const arr: Array<{ id: string; data: () => Record<string, unknown> }> = [];
        snap.forEach((d) => arr.push(d));
        return arr;
      }
      const [mine, shared] = await Promise.all([
        adminDb().collection("backends").where("owner_user_id", "==", tenant.userId).limit(100).get(),
        adminDb().collection("backends").where("tier_scope", "==", "shared").limit(100).get(),
      ]);
      const seen = new Set<string>();
      const merged: Array<{ id: string; data: () => Record<string, unknown> }> = [];
      mine.forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); merged.push(d); } });
      shared.forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); merged.push(d); } });
      return merged;
    };
    const docs = await collectDocs();
    // Give downstream loops the same `forEach` shape they had before.
    const snap = { forEach: (fn: (d: { id: string; data: () => Record<string, unknown> }) => void) => {
      for (const d of docs) fn(d);
    }};
    const now = Date.now();
    const out: Array<Record<string, unknown>> = [];

    // Pre-fetch active jobs so Monitor cards can render progress + step
    // for outbound-poll workers (their /api/stats can't be polled).
    // Collects the set of active_job_ids and fetches them ONCE in
    // parallel — bounded by the number of alive workers (usually 1).
    const activeIds = new Set<string>();
    snap.forEach((doc) => {
      const d = doc.data() as { active_job_id?: string };
      if (d.active_job_id) activeIds.add(d.active_job_id);
    });
    const jobsById = new Map<string, Record<string, unknown>>();
    await Promise.all([...activeIds].map(async (jid) => {
      try {
        const j = await adminDb().collection("jobs").doc(jid).get();
        if (j.exists) jobsById.set(jid, j.data() || {});
      } catch { /* worker may have a stale id; ignore */ }
    }));
    // Docs we delete inline — corpse cleanup so the Monitor page doesn't
    // show a 'ghost' worker for 3 min after Terminate.
    const stalePendingIds: string[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const lastMs = toEpochMs(d.last_seen_at ?? d.last_seen);
      const startedMs = toEpochMs(d.started_at);
      const alive = lastMs != null && (now - lastMs) < 180_000;
      const shutdown_pending = !!d.shutdown_pending;

      // Aggressive cleanup for terminated workers:
      //   - shutdown_pending flag was set (dashboard sent Terminate), AND
      //   - heartbeat stopped >30 s ago (worker acted on the flag).
      // Once both are true, the worker will never come back — remove
      // the row so the UI stops showing a stale card. 30 s is our
      // slack for one missed heartbeat before we call it gone.
      if (shutdown_pending && lastMs != null && (now - lastMs) > 30_000) {
        stalePendingIds.push(doc.id);
        return;
      }
      // Also drop rows without ANY heartbeat (broken register).
      if (!lastMs) return;
      // Drop rows silent for >30 min — worker died without deregister.
      if ((now - lastMs) > 30 * 60_000) {
        stalePendingIds.push(doc.id);
        return;
      }
      // Inline the active job so the Monitor card can show step +
      // progress without a per-card fetch. Only sends the fields the UI
      // actually reads.
      const activeJobId = String(d.active_job_id || "");
      const job = activeJobId ? jobsById.get(activeJobId) : null;
      const active_job = job ? {
        id:                  activeJobId,
        run_id:              String(job.run_id || ""),
        channel:             String(job.channel || ""),
        current_step:        String(job.current_step || ""),
        current_step_label:  String(job.current_step_label || ""),
        percent:             Number(job.percent ?? 0),
        started_at:          Number(job.started_at ?? 0),
      } : null;

      out.push({
        instance_id: (d.instance_id as string) || doc.id,
        url:         String(d.url || ""),
        status:      d.status === "busy" ? "busy" : "available",
        queue_depth: Number(d.queue_depth ?? 0),
        last_seen:   lastMs != null ? lastMs / 1000 : 0,
        started_at:  startedMs != null ? startedMs / 1000 : null,
        // Preserve the tier as-reported by the worker. Only fall back
        // to 'gpu' when it's missing so the Monitor doesn't hide the
        // card. New tiers ('dashboard' for the side-worker) pass
        // through unchanged.
        tier:        typeof d.tier === "string" && d.tier ? String(d.tier) : "gpu",
        label:       (d.label as string) ?? null,
        gpu_name:    (d.gpu_name as string) ?? null,
        version:     (d.version as string) ?? null,
        alive,
        mode:        (d.mode as string) || "unknown",
        stats:       (d.stats as Record<string, unknown>) ?? null,
        active_job_id: activeJobId,
        active_job,
        shutdown_pending,
      });
    });
    // Fire-and-forget cleanup. Don't await — Monitor should get its
    // fresh list immediately; deletes happen in the background.
    if (stalePendingIds.length > 0) {
      Promise.all(stalePendingIds.map((id) =>
        adminDb().collection("backends").doc(id).delete().catch(() => null),
      ));
    }
    out.sort((a, b) => Number(b.last_seen) - Number(a.last_seen));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
