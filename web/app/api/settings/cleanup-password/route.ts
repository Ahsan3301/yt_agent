import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { newRequestId, logRoute } from "@/app/api/_lib/orchestrator";
import { requireTenant } from "@/lib/tenant";
import { hashOraclePassword, verifyOraclePassword } from "@/lib/oracle_password";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET  /api/settings/cleanup-password  -> { set: boolean }
 * PUT  /api/settings/cleanup-password  -> { password, current? }
 *
 * Why this file exists: cleanup-now is password-gated against
 * settings/cleanup_password, and when no password is set it answered
 * "configure via PUT /api/settings/cleanup-password first". That route
 * had never been written. So the gate could never be satisfied: no
 * password existed, nothing could create one, and the endpoint named in
 * the error was fictional. "Run cleanup now" was unreachable from the
 * dashboard for every install.
 *
 * Setting a password the first time only needs a signed-in tenant.
 * CHANGING one additionally requires the current password — otherwise
 * anyone who reached an authenticated session could rotate the gate on
 * a destructive, irreversible action.
 */

const DOC = "cleanup_password";

async function _hash(): Promise<string | null> {
  try {
    const doc = await adminDb().collection("settings").doc(DOC).get();
    if (!doc.exists) return null;
    // PB stores {id, data(json), updated_at} and drops undeclared
    // top-level fields, so the hash lives under `data`. Read both
    // shapes so a Firestore-backed install keeps working.
    const d = doc.data() as { data?: { hash?: string }; hash?: string } | undefined;
    return d?.data?.hash || d?.hash || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const t = await requireTenant(req);
  if (t instanceof NextResponse) return t;
  return NextResponse.json({ set: Boolean(await _hash()) });
}

export async function PUT(req: NextRequest) {
  const reqId = newRequestId();
  const t = await requireTenant(req);
  if (t instanceof NextResponse) return t;

  const body = (await req.json().catch(() => ({}))) as {
    password?: string;
    current?: string;
  };
  const next = String(body.password || "").trim();
  if (next.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters." },
      { status: 400 },
    );
  }

  const existing = await _hash();
  if (existing) {
    const cur = String(body.current || "").trim();
    if (!cur || !(await verifyOraclePassword(cur, existing))) {
      return NextResponse.json(
        { error: "Current password is required to change it." },
        { status: 401 },
      );
    }
  }

  const hash = await hashOraclePassword(next);
  await adminDb()
    .collection("settings")
    .doc(DOC)
    .set({ data: { hash }, updated_at: Math.floor(Date.now() / 1000) });

  logRoute(reqId, "cleanup-password: updated", { first_time: !existing });
  return NextResponse.json({ ok: true, set: true });
}
