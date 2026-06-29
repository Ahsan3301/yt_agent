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
      return NextResponse.json({ error: "backend not found" }, { status: 404 });
    }
    const data = snap.data() as { url?: string };
    const url = data.url;
    if (!url) {
      return NextResponse.json({ error: "backend has no public url" }, { status: 400 });
    }
    const r = await fetch(`${url.replace(/\/$/, "")}/api/shutdown`, {
      method: "POST",
      headers: { "X-Vercel-Gateway": "1" },
    });
    if (!r.ok) {
      const body = await r.text();
      return NextResponse.json(
        { error: `worker returned ${r.status}`, body: body.slice(0, 300) },
        { status: 502 },
      );
    }
    const body = await r.json().catch(() => ({}));
    // Also clear the backends/<id> doc so the dashboard doesn't keep
    // showing it as alive for the 90-sec freshness window.
    try {
      await adminDb().collection("backends").doc(id).delete();
    } catch { /* non-fatal */ }
    return NextResponse.json({ ok: true, worker: body });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
