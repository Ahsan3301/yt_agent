import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { quotaStatus } from "@/lib/quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Where the signed-in user stands: limits, usage today, trial state. */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    return NextResponse.json({ ok: true, ...(await quotaStatus(auth.tenant.userId)) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
