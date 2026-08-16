import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Quota increase requests.
 *
 *   GET  — this user's own requests, newest first.
 *   POST — ask for more channels / videos-per-day / trial days.
 *
 * Writes to `quota_requests` (migration 0034). The collection has no
 * public API rules, so everything goes through the admin client here
 * with the tenant's own id stamped server-side — a client cannot ask
 * on someone else's behalf by posting a different user_id.
 *
 * Nothing is granted here. A request is a message to the operator; the
 * approval path is what actually moves a limit. That separation is the
 * point: the operator pays for the compute and decides who gets it.
 */

const MAX_OPEN_REQUESTS = 3;

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const tenant = auth.tenant;
  try {
    const snap = await adminDb().collection("quota_requests").limit(200).get();
    const mine: Record<string, unknown>[] = [];
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      if (String(r.user_id || "") === tenant.userId) mine.push({ id: d.id, ...r });
    });
    mine.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return NextResponse.json({ ok: true, requests: mine });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const tenant = auth.tenant;

  let b: Record<string, unknown>;
  try { b = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const n = (v: unknown) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x > 0 ? Math.min(x, 1000) : 0;
  };
  const wantChannels = n(b.want_channels);
  const wantVideos = n(b.want_videos_per_day);
  const wantDays = n(b.want_days);
  const reason = String(b.reason || "").slice(0, 2000).trim();

  // An empty request is a support ticket with no content — reject it
  // here rather than letting the operator open it to find nothing.
  if (!wantChannels && !wantVideos && !wantDays) {
    return NextResponse.json(
      { error: "Tell us what you need — channels, videos per day, or more days." },
      { status: 400 },
    );
  }

  try {
    // Cap open requests. Without this a frustrated user can bury the
    // operator's queue in duplicates of the same ask, which makes the
    // queue useless exactly when it matters.
    const snap = await adminDb().collection("quota_requests").limit(200).get();
    let open = 0;
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      if (String(r.user_id || "") === tenant.userId && String(r.status || "") === "pending") open += 1;
    });
    if (open >= MAX_OPEN_REQUESTS) {
      return NextResponse.json(
        { error: `You already have ${open} pending requests. We'll get to them shortly.` },
        { status: 429 },
      );
    }

    // .doc().set(), not .add() — the PocketBase adapter does not
    // implement add(). Same class as the runTransaction gap documented
    // in api/jobs/claim: a Firestore method the adapter never got, which
    // fails at runtime rather than at build.
    // Denormalise the email onto the request. Tenant carries only the
    // id, and an operator triaging a queue should not have to join to
    // app_users to find out who is asking.
    let email = "";
    try {
      const u = await adminDb().collection("app_users").doc(tenant.userId).get();
      if (u.exists) email = String((u.data() as Record<string, unknown>)?.email || "");
    } catch { /* the request stands without it */ }

    const ref = adminDb().collection("quota_requests").doc();
    await ref.set({
      user_id: tenant.userId,
      email,
      want_channels: wantChannels,
      want_videos_per_day: wantVideos,
      want_days: wantDays,
      reason,
      status: "pending",
    });
    return NextResponse.json({ ok: true, id: ref.id, status: "pending" });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
