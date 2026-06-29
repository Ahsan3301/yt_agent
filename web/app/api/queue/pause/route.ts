import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET  /api/queue/pause  → { paused: boolean }
 * POST /api/queue/pause  body: { paused: boolean }
 *
 * Stored at queue_state/global. When paused=true, workers refuse to
 * claim new queued jobs (the claim_queued transaction reads this flag).
 * Already-running jobs are unaffected.
 */
export async function GET() {
  try {
    const snap = await adminDb().collection("queue_state").doc("global").get();
    const v = snap.exists ? (snap.data() as { paused?: boolean }) : { paused: false };
    return NextResponse.json({ paused: !!v.paused });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const paused = !!body.paused;
    await adminDb()
      .collection("queue_state")
      .doc("global")
      .set({ paused, updated_at: FieldValue.serverTimestamp() }, { merge: true });
    return NextResponse.json({ ok: true, paused });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
