import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Per-user queue pause switch.
 *
 *   GET  /api/queue/pause  → { paused: boolean }
 *   POST /api/queue/pause  body: { paused: boolean }
 *
 * Under tenant enforcement, each caller reads/writes their own
 * paused__{userId} shadow. Legacy queue_state/global remains as a
 * global fallback (nothing reads it after Phase 2b, but keeping the
 * row lets us roll back cleanly).
 *
 * Note: the CLAIM route (workers/jobs/claim) still reads the global
 * row. Making workers respect a per-user pause would require the
 * claim query to look up the job's owner's pause state — deferred
 * to a followup since single-tenant use is what matters today.
 */
const LEGACY_ID = "global";
function _shadowId(userId: string): string { return `paused__${userId}`; }

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const primary = await adminDb().collection("queue_state").doc(_shadowId(auth.tenant.userId)).get();
    const snap = primary.exists ? primary :
      await adminDb().collection("queue_state").doc(LEGACY_ID).get();
    const v = snap.exists ? (snap.data() as { paused?: boolean }) : { paused: false };
    return NextResponse.json({ paused: !!v.paused });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const body = await req.json().catch(() => ({}));
    const paused = !!body.paused;
    await adminDb()
      .collection("queue_state")
      .doc(_shadowId(auth.tenant.userId))
      .set({
        paused,
        user_id: auth.tenant.userId,
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
    return NextResponse.json({ ok: true, paused });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
