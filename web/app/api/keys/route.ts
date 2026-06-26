import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Mirror of MANAGED_KEYS in backend/keys_sync.py — kept in sync manually.
const MANAGED_KEYS = [
  "GROQ_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "SHUTTERSTOCK_API_TOKEN",
  "SHUTTERSTOCK_CLIENT_ID",
  "SHUTTERSTOCK_CLIENT_SECRET",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
  "COVERR_API_KEY",
  "HF_TOKEN",
];

function _mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return v.slice(0, 4) + "*".repeat(v.length - 8) + v.slice(-4);
}

/** GET /api/keys — return masked status for every managed key. */
export async function GET() {
  const reqId = newRequestId();
  try {
    const snap = await adminDb().collection("api_keys").get();
    const stored: Record<string, string> = {};
    snap.forEach((doc) => {
      const d = doc.data() as { value?: unknown };
      if (d && typeof d.value === "string") stored[doc.id] = d.value;
    });
    const out: Record<string, { set: boolean; masked: string; managed: true }> = {};
    for (const k of MANAGED_KEYS) {
      const v = stored[k] || "";
      out[k] = { set: !!v, masked: _mask(v), managed: true };
    }
    logRoute(reqId, "keys get", { set_count: Object.values(out).filter(x => x.set).length });
    return NextResponse.json(out);
  } catch (e) {
    logRoute(reqId, "keys get failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * PUT /api/keys — batch update. Body shape: { updates: { KEY: value|null } }
 * value === null OR "" deletes the key from the central store.
 */
export async function PUT(req: NextRequest) {
  const reqId = newRequestId();
  try {
    const body = await req.json();
    const updates = (body?.updates || {}) as Record<string, string | null>;
    const batch = adminDb().batch();
    const coll = adminDb().collection("api_keys");
    let changed = 0;
    for (const [name, value] of Object.entries(updates)) {
      if (!MANAGED_KEYS.includes(name)) continue;
      const ref = coll.doc(name);
      if (value == null || value === "") {
        batch.delete(ref);
      } else {
        batch.set(ref, {
          value: String(value),
          updated_at: FieldValue.serverTimestamp(),
        });
      }
      changed += 1;
    }
    if (changed > 0) await batch.commit();
    logRoute(reqId, "keys put", { changed });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logRoute(reqId, "keys put failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
