import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { toEpochMs } from "@/lib/timestamps";

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
export async function GET() {
  try {
    const snap = await adminDb().collection("backends").limit(100).get();
    const now = Date.now();
    const out: Array<Record<string, unknown>> = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      const lastMs = toEpochMs(d.last_seen_at ?? d.last_seen);
      const startedMs = toEpochMs(d.started_at);
      // 3 min freshness window — matches the Firestore-branch code.
      const alive = lastMs != null && (now - lastMs) < 180_000;
      if (!alive && !lastMs) return; // no heartbeat ever → hide
      out.push({
        instance_id: (d.instance_id as string) || doc.id,
        url:         String(d.url || ""),
        status:      d.status === "busy" ? "busy" : "available",
        queue_depth: Number(d.queue_depth ?? 0),
        last_seen:   lastMs != null ? lastMs / 1000 : 0,
        started_at:  startedMs != null ? startedMs / 1000 : null,
        tier:        d.tier === "cpu" ? "cpu" : "gpu",
        label:       (d.label as string) ?? null,
        gpu_name:    (d.gpu_name as string) ?? null,
        version:     (d.version as string) ?? null,
        alive,
        mode:        (d.mode as string) || "unknown",
      });
    });
    // Fresh workers first.
    out.sort((a, b) => Number(b.last_seen) - Number(a.last_seen));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
