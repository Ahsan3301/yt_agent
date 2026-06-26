import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DOC = "default";

/** GET /api/settings — read the single settings doc from Firestore. */
export async function GET() {
  const reqId = newRequestId();
  try {
    const snap = await adminDb().collection("settings").doc(DOC).get();
    if (!snap.exists) {
      logRoute(reqId, "settings empty");
      return NextResponse.json({});
    }
    const d = snap.data() as { data?: unknown };
    return NextResponse.json(d?.data || {});
  } catch (e) {
    logRoute(reqId, "settings get failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
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
