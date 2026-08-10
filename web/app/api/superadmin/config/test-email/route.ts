import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { verifyAndTest } from "@/lib/mailer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/superadmin/config/test-email
 *
 * Sends one test message using whatever SMTP settings are currently
 * saved, and reports the real result.
 *
 * Exists because SMTP misconfiguration is silent by nature: a wrong
 * password, an unverified From address or a blocked port all look
 * identical from the dashboard — settings saved, nothing arrives.
 * Without this the first sign of trouble is a customer enquiry that
 * never reached anyone, and by then you cannot tell whether the form
 * is broken or nobody wrote in.
 *
 * Superadmin only: it sends real mail from the operator's server.
 */
export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const res = await verifyAndTest();
  // 200 either way — a failed send is a valid, expected answer to
  // "does this work?", and the page renders `detail` regardless.
  return NextResponse.json(res);
}
