import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Per-user shadow — same pattern as /api/keys. Phase-1 migration
// seeded the founder's shadow from the legacy singleton; new users
// start with an empty shadow that falls back to DEFAULT_SETTINGS.
const LEGACY_DOC = "default";
function _shadowId(userId: string): string { return `${userId}__default`; }

/**
 * Default settings returned when no persisted doc exists yet (fresh
 * install). The Settings page expects every top-level key to exist —
 * returning {} would cause a client-side crash when it accesses
 * s.content.channel etc. Defaults here mirror the keys the page
 * actually reads; saving the form merges these with user changes.
 */
const DEFAULT_SETTINGS = {
  content: {
    channel: "horror" as const,
    tone: "atmospheric",
    target_word_min: 160,
    target_word_max: 200,
    manual_premise: "",
    videos_per_run: 1,
  },
  voice: {} as Record<string, unknown>,
  video: {} as Record<string, unknown>,
  upload: {} as Record<string, unknown>,
  keywords: {} as Record<string, string[]>,
  music_keywords: {} as Record<string, string>,
  providers: {} as Record<string, boolean>,
};

/** GET /api/settings — read the caller's settings doc (per-user
 *  shadow); falls back to the legacy singleton when the shadow is
 *  empty; falls back to DEFAULT_SETTINGS when neither exists. */
export async function GET(req: NextRequest) {
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const shadow = await adminDb().collection("settings").doc(_shadowId(auth.tenant.userId)).get();
    const snap = shadow.exists ? shadow :
      await adminDb().collection("settings").doc(LEGACY_DOC).get();
    if (!snap.exists) {
      logRoute(reqId, "settings empty — returning defaults");
      return NextResponse.json(DEFAULT_SETTINGS);
    }
    const d = snap.data() as { data?: Record<string, unknown> | string };
    const merged: Record<string, unknown> =
      typeof d?.data === "string" ? JSON.parse(d.data) :
      (d?.data as Record<string, unknown> | undefined) || {};
    return NextResponse.json({ ...DEFAULT_SETTINGS, ...merged });
  } catch (e) {
    logRoute(reqId, "settings get failed", { err: String(e) });
    return NextResponse.json(DEFAULT_SETTINGS);
  }
}

/** PUT /api/settings — overwrite the caller's per-user shadow. */
export async function PUT(req: NextRequest) {
  const reqId = newRequestId();
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "expected object" }, { status: 400 });
    }
    await adminDb().collection("settings").doc(_shadowId(auth.tenant.userId)).set({
      data: body,
      updated_at: FieldValue.serverTimestamp(),
      user_id: auth.tenant.userId,
    });
    logRoute(reqId, "settings put", { user: auth.tenant.userId, keys: Object.keys(body).length });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logRoute(reqId, "settings put failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
