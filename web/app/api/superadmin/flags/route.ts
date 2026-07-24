import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { _bustFlagsCache } from "@/lib/flags";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Superadmin feature-flag CRUD.
 *
 *   GET  → returns current flag values from settings/ktt7sdazit7wnsk
 *          (the row created by migration 0016). Missing = all false.
 *   PUT  → { flag_name: bool, ... } — merges into the row.
 *          Immediately busts the 30s cache in web/lib/flags.ts so
 *          gated behaviour changes on the very next request.
 *
 * Every save writes to audit_log with before + after snapshots.
 */
const FLAGS_DOC_ID = "ktt7sdazit7wnsk"; // _pbId("flags") — see migration 0016

const KNOWN_FLAGS = [
  "auth_v2_enabled",
  "tenant_filter_enforced",
  "signup_open",
  "quotas_enforced",
  "shared_pool_enabled",
  "landing_cms_enabled",
] as const;

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const snap = await adminDb().collection("settings").doc(FLAGS_DOC_ID).get();
    const raw = snap.exists ? (snap.data() as { data?: unknown }).data : undefined;
    const parsed: Record<string, unknown> =
      typeof raw === "string" ? JSON.parse(raw) :
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    // Ensure every known flag has a boolean value in the response so
    // the UI can render toggles without undefined juggling.
    const out: Record<string, boolean> = {};
    for (const k of KNOWN_FLAGS) out[k] = Boolean(parsed[k]);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  try {
    const ref = adminDb().collection("settings").doc(FLAGS_DOC_ID);
    const before = await ref.get();
    const beforeData: Record<string, unknown> = (() => {
      if (!before.exists) return {};
      const raw = (before.data() as { data?: unknown }).data;
      if (typeof raw === "string") try { return JSON.parse(raw); } catch { return {}; }
      return (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
    })();

    const next: Record<string, boolean> = {};
    for (const k of KNOWN_FLAGS) {
      next[k] = k in body ? Boolean(body[k]) : Boolean(beforeData[k]);
    }

    await ref.set({
      data: JSON.stringify(next),
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    _bustFlagsCache();

    // Diff for the audit entry.
    const changed: Record<string, { from: boolean; to: boolean }> = {};
    for (const k of KNOWN_FLAGS) {
      if (Boolean(beforeData[k]) !== next[k]) {
        changed[k] = { from: Boolean(beforeData[k]), to: next[k] };
      }
    }
    if (Object.keys(changed).length > 0) {
      await audit(auth.tenant, {
        action: "flags.update", target_type: "settings", target_id: FLAGS_DOC_ID,
        meta: { changed },
      }, req);
    }
    return NextResponse.json({ ok: true, flags: next, changed });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
