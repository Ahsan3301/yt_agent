import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/users
 *
 * Admin+ only. Lists every app_users row, sanitized (no password_hash,
 * no kaggle_key). Supports optional ?status=pending filter for the
 * approvals queue.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "admin" && auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const status = req.nextUrl.searchParams.get("status") || "";
    let q = adminDb().collection("app_users").limit(500);
    if (status && ["pending", "active", "suspended"].includes(status)) {
      q = q.where("status", "==", status);
    }
    const snap = await q.get();
    const out: unknown[] = [];
    snap.forEach((doc) => {
      const d = doc.data() as Record<string, unknown>;
      // Never leak the password hash or kaggle key back to the admin UI.
      // Show whether they're set, not the values.
      out.push({
        id: doc.id,
        email: d.email,
        role: d.role,
        status: d.status,
        plan_id: d.plan_id,
        has_kaggle_key: Boolean(d.kaggle_username && d.kaggle_key),
        kaggle_username: d.kaggle_username || "",
        approved_by: d.approved_by || null,
        approved_at: d.approved_at || null,
        created_at: d.created_at || null,
        last_login_at: d.last_login_at || null,
      });
    });
    // Sort newest signup first — easier triage.
    out.sort((a, b) => Number((b as { created_at?: number }).created_at || 0)
                     - Number((a as { created_at?: number }).created_at || 0));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
