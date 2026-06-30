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
  "DISCORD_WEBHOOK_URL",
  "YOUTUBE_REFRESH_TOKEN",
  "RENDER_TRIGGER_KEY",
  // Storage credentials — see backend/keys_sync.MANAGED_KEYS comment.
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_URL",
  "SFTP_HOST",
  "SFTP_PORT",
  "SFTP_USER",
  "SFTP_PASS",
  "SFTP_BASE_DIR",
  "PUBLIC_BASE_URL",
];

function _mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return v.slice(0, 4) + "*".repeat(v.length - 8) + v.slice(-4);
}

/**
 * Records are keyed by the `key_name` field (added in PB migration
 * 0002), NOT the doc id. PB ids are opaque 15-char strings; we never
 * try to reverse-engineer the original key name from them. All
 * lookups use `where("key_name", "==", X)`.
 */

async function _findByName(name: string): Promise<{ id: string; value: string } | null> {
  const snap = await adminDb()
    .collection("api_keys")
    .where("key_name", "==", name)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const d = snap.docs[0].data() as { value?: unknown };
  return {
    id: snap.docs[0].id,
    value: typeof d.value === "string" ? d.value : "",
  };
}

/** GET /api/keys — return masked status for every managed key. */
export async function GET() {
  const reqId = newRequestId();
  try {
    const snap = await adminDb().collection("api_keys").get();
    // Build {key_name: value} from the rows themselves. Doc ids are
    // opaque PB ids; rely on the `key_name` field for identity.
    const stored: Record<string, string> = {};
    snap.forEach((doc) => {
      const d = doc.data() as { key_name?: unknown; value?: unknown };
      const k = typeof d.key_name === "string" ? d.key_name : "";
      const v = typeof d.value === "string" ? d.value : "";
      if (k) stored[k] = v;
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
    const coll = adminDb().collection("api_keys");
    let changed = 0;
    for (const [name, value] of Object.entries(updates)) {
      if (!MANAGED_KEYS.includes(name)) continue;
      const existing = await _findByName(name);
      if (value == null || value === "") {
        // Delete if it exists; no-op if not.
        if (existing) {
          await coll.doc(existing.id).delete();
          changed += 1;
        }
      } else {
        if (existing) {
          await coll.doc(existing.id).update({
            value: String(value),
            updated_at: FieldValue.serverTimestamp(),
          });
        } else {
          // .doc() with no arg = auto-id. PB rejects writes whose
          // doc id isn't the PB-format 15-char alphanumeric; let it
          // generate one.
          await coll.doc().set({
            key_name: name,
            value: String(value),
            updated_at: FieldValue.serverTimestamp(),
          });
        }
        changed += 1;
      }
    }
    logRoute(reqId, "keys put", { changed });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logRoute(reqId, "keys put failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
