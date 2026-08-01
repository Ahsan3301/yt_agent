import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { checkPool, readPoolHealth } from "@/lib/pool-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET  → last stored health of the shared credential pool (no network)
 * POST → probe every pooled credential against its provider now
 *
 * Same split as the YouTube health endpoint: the pool page reads
 * stored status on load, and only spends provider round trips when
 * asked or when the daily sweep runs.
 */

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(await readPoolHealth());
}

export async function POST(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    return NextResponse.json(await checkPool(true));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
