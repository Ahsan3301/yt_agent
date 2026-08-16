import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { bustQuotaCache } from "@/lib/quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Operator view of quota requests.
 *
 *   GET  ?status=pending      — the triage queue.
 *   POST { id, action, ... }  — approve (optionally amending the ask)
 *                               or deny.
 *
 * Superadmin only. This is the endpoint that actually MOVES a limit,
 * which is why the user-facing route grants nothing: the operator pays
 * for the compute and decides who gets it.
 *
 * Approving writes the granted values onto app_users as overrides, and
 * an override beats the plan (see lib/quota). Granting days extends
 * trial_expires_at from max(now, current expiry) for the same reason
 * the referral grant does — a user with time left keeps it, a lapsed
 * one starts today rather than having days added to a past date.
 *
 * The cache is busted immediately so the user's very next request sees
 * the new limit. Without that they would sit blocked for up to 60s
 * after being told they were approved, which reads as the approval not
 * working.
 */

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (!auth.tenant.isSuper) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const want = String(new URL(req.url).searchParams.get("status") || "").trim();
  try {
    const snap = await adminDb().collection("quota_requests").limit(500).get();
    const rows: Record<string, unknown>[] = [];
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      if (want && String(r.status || "") !== want) return;
      rows.push({ id: d.id, ...r });
    });
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return NextResponse.json({ ok: true, requests: rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (!auth.tenant.isSuper) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let b: Record<string, unknown>;
  try { b = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const id = String(b.id || "").trim();
  const action = String(b.action || "").trim();
  if (!id || (action !== "approve" && action !== "deny")) {
    return NextResponse.json({ error: "id and action (approve|deny) required" }, { status: 400 });
  }

  const n = (v: unknown) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) && x > 0 ? Math.min(x, 1000) : 0;
  };
  const now = Math.floor(Date.now() / 1000);

  try {
    const ref = adminDb().collection("quota_requests").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = (doc.data() || {}) as Record<string, unknown>;

    // Deciding twice would double-grant. The ledger records who decided
    // and when, so a second call is a mistake rather than an update.
    if (String(r.status || "") !== "pending") {
      return NextResponse.json(
        { error: `already ${r.status}`, decided_at: r.decided_at || null },
        { status: 409 },
      );
    }

    if (action === "deny") {
      await ref.set({
        status: "denied",
        decided_by: auth.tenant.userId, decided_at: now,
        note: String(b.note || "").slice(0, 2000),
      }, { merge: true });
      return NextResponse.json({ ok: true, status: "denied" });
    }

    // Operator may amend the ask — grant less (or more) than requested.
    const gCh = n(b.granted_channels ?? r.want_channels);
    const gVd = n(b.granted_videos_per_day ?? r.want_videos_per_day);
    const gDays = n(b.granted_days ?? r.want_days);
    const userId = String(r.user_id || "");
    if (!userId) return NextResponse.json({ error: "request has no user" }, { status: 422 });

    const patch: Record<string, unknown> = {};
    if (gCh) patch.quota_channels = gCh;
    if (gVd) patch.quota_videos_per_day = gVd;

    if (gDays) {
      const u = await adminDb().collection("app_users").doc(userId).get();
      const cur = u.exists ? Number((u.data() as Record<string, unknown>)?.trial_expires_at || 0) : 0;
      patch.trial_expires_at = Math.max(now, cur) + gDays * 86400;
    }

    if (Object.keys(patch).length) {
      await adminDb().collection("app_users").doc(userId).set(patch, { merge: true });
      // The user's next call must see this, not a 60s-stale count.
      bustQuotaCache(userId);
    }

    await ref.set({
      status: "approved",
      granted_channels: gCh, granted_videos_per_day: gVd, granted_days: gDays,
      decided_by: auth.tenant.userId, decided_at: now,
      note: String(b.note || "").slice(0, 2000),
    }, { merge: true });

    return NextResponse.json({
      ok: true, status: "approved",
      granted: { channels: gCh, videos_per_day: gVd, days: gDays },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
