import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DOC = "default";

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

/** GET /api/settings — read the single settings doc. Returns sensible
 * defaults when no doc exists yet (fresh install). */
export async function GET() {
  const reqId = newRequestId();
  try {
    const snap = await adminDb().collection("settings").doc(DOC).get();
    if (!snap.exists) {
      logRoute(reqId, "settings empty — returning defaults");
      return NextResponse.json(DEFAULT_SETTINGS);
    }
    const d = snap.data() as { data?: Record<string, unknown> };
    return NextResponse.json({ ...DEFAULT_SETTINGS, ...(d?.data || {}) });
  } catch (e) {
    logRoute(reqId, "settings get failed", { err: String(e) });
    // Still return defaults on backend error so the page is usable.
    return NextResponse.json(DEFAULT_SETTINGS);
  }
}

/** PUT /api/settings — overwrite the settings doc with the body. */
export async function PUT(req: NextRequest) {
  const reqId = newRequestId();
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "expected object" }, { status: 400 });
    }
    await adminDb().collection("settings").doc(DOC).set({
      data: body,
      updated_at: FieldValue.serverTimestamp(),
    });
    logRoute(reqId, "settings put", { keys: Object.keys(body).length });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logRoute(reqId, "settings put failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
