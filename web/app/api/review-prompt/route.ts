import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Should we ask this user for a review, and record what they answered.
 *
 *   GET  -> { show, published, url_g2, url_capterra }
 *   POST -> { action: "dismiss" | "submitted" }
 *
 * NOTHING IS GATED ON THIS. G2 and Capterra both prohibit review gating
 * — conditioning access, features or rewards on leaving a review — and
 * enforcement runs to purging reviews and suspending the vendor
 * profile. So this endpoint reports whether to ASK; it never reports
 * whether to allow. "submitted" is the user's word for it, taken on
 * trust, and buys them nothing but silence.
 */

/** Videos published before we ask. Low enough that they have seen the
 *  product work, high enough that they have something to say. */
const MIN_PUBLISHED = 3;

/** How long a dismissal is respected before asking again. */
const SNOOZE_DAYS = 14;

/** Total asks before giving up for good. A prompt that returns forever
 *  is a nag, and a nag earns one-star reviews rather than five. */
const MAX_ASKS = 3;

async function _publishedCount(userId: string): Promise<number> {
  try {
    const snap = await adminDb().collection("runs_index").limit(500).get();
    let n = 0;
    snap.forEach((d) => {
      const r = (d.data() || {}) as Record<string, unknown>;
      if (!r.youtube_video_id) return;
      if (String(r.user_id || r.owner_user_id || "") !== userId) return;
      n += 1;
    });
    return n;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const userId = auth.tenant.userId;

  try {
    const doc = await adminDb().collection("app_users").doc(userId).get();
    const u = (doc.exists ? doc.data() || {} : {}) as Record<string, unknown>;

    const submitted = Number(u.review_submitted_at || 0) > 0;
    const shown = Number(u.review_prompt_shown_count || 0);
    const dismissedAt = Number(u.review_prompt_dismissed_at || 0);
    const now = Math.floor(Date.now() / 1000);
    const snoozed = dismissedAt > 0 && now - dismissedAt < SNOOZE_DAYS * 86400;

    // Cheap exits first — do not count videos for someone we would not
    // ask anyway.
    if (submitted || shown >= MAX_ASKS || snoozed) {
      return NextResponse.json({ ok: true, show: false });
    }

    const published = await _publishedCount(userId);
    return NextResponse.json({
      ok: true,
      show: published >= MIN_PUBLISHED,
      published,
      url_g2: "https://www.g2.com/products/yven/reviews",
      url_capterra: "https://www.capterra.com/p/yven/",
    });
  } catch (e) {
    // Informational only — never break the dashboard over a prompt.
    return NextResponse.json({ ok: true, show: false, error: String(e) });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const userId = auth.tenant.userId;

  let b: Record<string, unknown>;
  try { b = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const action = String(b.action || "").trim();
  if (action !== "dismiss" && action !== "submitted") {
    return NextResponse.json({ error: "action must be dismiss|submitted" }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const doc = await adminDb().collection("app_users").doc(userId).get();
    const u = (doc.exists ? doc.data() || {} : {}) as Record<string, unknown>;
    const shown = Number(u.review_prompt_shown_count || 0);

    const patch: Record<string, unknown> =
      action === "submitted"
        ? { review_submitted_at: now }
        : {
            review_prompt_dismissed_at: now,
            // Counted on DISMISS, not on render. Counting renders would
            // burn the allowance on a user who reloaded the dashboard
            // three times without reading it.
            review_prompt_shown_count: shown + 1,
          };

    await adminDb().collection("app_users").doc(userId).set(patch, { merge: true });
    return NextResponse.json({ ok: true, action });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
