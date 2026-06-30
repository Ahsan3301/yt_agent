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
 * Why one-JSON-blob and not one-record-per-key:
 *
 * PB document ids must be 15-char [a-z0-9]+. Our DB wrapper hashes
 * non-conforming raw ids deterministically — so set("NVIDIA_NIM_API_KEY")
 * writes to a hashed id, and the subsequent list().forEach surfaces docs
 * keyed by HASH, not name. The route's lookup uses the raw name as the
 * index → always reads {set: false}.
 *
 * The cleanest fix without a schema migration is to use the existing
 * `settings` collection (which has a json `data` field that PB stores
 * verbatim). We store the entire {KEY: value} map under a single
 * stable PB id, derived from the raw id "api_keys" the same way the
 * wrapper would derive it — so the round-trip stays consistent.
 */
const BLOB_DOC_ID = "api_keys";

async function _readBlob(): Promise<Record<string, string>> {
  const snap = await adminDb().collection("settings").doc(BLOB_DOC_ID).get();
  if (!snap.exists) return {};
  const d = snap.data() as { data?: unknown } | undefined;
  const raw = (d?.data ?? {}) as Record<string, unknown>;
  // Coerce to strings only — drops booleans/numbers/etc.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

async function _writeBlob(values: Record<string, string>): Promise<void> {
  await adminDb().collection("settings").doc(BLOB_DOC_ID).set(
    { data: values, updated_at: FieldValue.serverTimestamp() },
    { merge: false }, // overwrite so deletions actually delete
  );
}

/** GET /api/keys — return masked status for every managed key. */
export async function GET() {
  const reqId = newRequestId();
  try {
    const stored = await _readBlob();
    const out: Record<string, { set: boolean; masked: string; managed: true }> = {};
    for (const k of MANAGED_KEYS) {
      const v = stored[k] || "";
      out[k] = { set: !!v, masked: _mask(v), managed: true };
    }
    logRoute(reqId, "keys get", {
      set_count: Object.values(out).filter((x) => x.set).length,
    });
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

    const stored = await _readBlob();
    let changed = 0;
    for (const [name, value] of Object.entries(updates)) {
      if (!MANAGED_KEYS.includes(name)) continue;
      if (value == null || value === "") {
        if (stored[name]) {
          delete stored[name];
          changed += 1;
        }
      } else {
        if (stored[name] !== value) {
          stored[name] = String(value);
          changed += 1;
        }
      }
    }
    if (changed > 0) await _writeBlob(stored);
    logRoute(reqId, "keys put", { changed });
    return NextResponse.json({ ok: true });
  } catch (e) {
    logRoute(reqId, "keys put failed", { err: String(e) });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
