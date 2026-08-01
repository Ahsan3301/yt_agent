import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/auth/me — identity of the caller.
 *
 * Client components had no way to find out who they were: role lives
 * in a middleware-injected request header, which only server
 * components can read. That meant operator-only UI (platform secrets,
 * worker scheduling, storage endpoints) was rendered to every paying
 * customer because the page simply had no way to know better.
 *
 * Returns only what the UI needs to make display decisions. Never
 * returns password material or third-party credentials — and note
 * that hiding UI is presentation, not authorisation: every route
 * still enforces its own access control server-side.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  const { tenant } = auth;

  let email = "";
  let plan_id = "";
  let status = "active";
  try {
    const snap = await adminDb().collection("app_users").doc(tenant.userId).get();
    if (snap.exists) {
      const d = (snap.data() || {}) as Record<string, unknown>;
      email   = String(d.email   || "");
      plan_id = String(d.plan_id || "");
      status  = String(d.status  || "active");
    }
  } catch {
    // Identity from the signed session is still valid without the
    // profile row; degrade rather than fail the whole request.
  }

  return NextResponse.json({
    user_id: tenant.userId,
    role: tenant.role,
    is_admin: tenant.role === "admin" || tenant.role === "superadmin",
    is_superadmin: tenant.role === "superadmin",
    email,
    plan_id,
    status,
  });
}
