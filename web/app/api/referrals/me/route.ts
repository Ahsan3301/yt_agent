import { NextRequest, NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { getReferralStatsFor } from "@/lib/referrals";
import { publicOrigin } from "@/app/api/_lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/referrals/me
 * Returns the caller's referral code + progress + joined-friend list.
 */
export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  try {
    const stats = await getReferralStatsFor(auth.tenant.userId);
    const origin = publicOrigin(req);
    return NextResponse.json({
      ...stats,
      share_url: `${origin}${stats.share_url_path}`,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
