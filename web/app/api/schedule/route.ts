import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LEGACY_ID = "default";
function _shadowId(userId: string): string { return `default__${userId}`; }

const DEFAULTS = {
  enabled: false,
  daily_targets: { horror: 1, wisdom: 0 } as Record<string, number>,
  publish_default: true,
  buffer_seconds: 0,
};

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const primary = await adminDb().collection("schedules").doc(_shadowId(auth.tenant.userId)).get();
    const snap = primary.exists ? primary :
      await adminDb().collection("schedules").doc(LEGACY_ID).get();
    if (!snap.exists) return NextResponse.json(DEFAULTS);
    const data = snap.data();
    return NextResponse.json({ ...DEFAULTS, ...data });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "expected object" }, { status: 400 });
    }
    const cleaned: Record<string, unknown> = {
      enabled: !!body.enabled,
      publish_default: body.publish_default !== false,
      buffer_seconds: Math.max(0, Math.min(3600, Number(body.buffer_seconds) || 0)),
      daily_targets: {} as Record<string, number>,
      user_id: auth.tenant.userId,
    };
    const targets = body.daily_targets || {};
    for (const [ch, n] of Object.entries(targets)) {
      (cleaned.daily_targets as Record<string, number>)[ch] = Math.max(
        0,
        Math.min(10, Number(n) || 0),
      );
    }
    cleaned.updated_at = FieldValue.serverTimestamp();
    await adminDb().collection("schedules").doc(_shadowId(auth.tenant.userId)).set(cleaned, { merge: true });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
