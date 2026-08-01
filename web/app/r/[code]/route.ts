import { NextRequest, NextResponse } from "next/server";
import { findReferralByCode } from "@/lib/referrals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /r/<code>
 *
 * Referral short-link. Sets a 30-day cookie holding the code and
 * redirects to /signup. The /api/auth/register route reads that
 * cookie (or a body field) to attribute the signup.
 *
 * Unknown codes still redirect to /signup — we don't want to leak
 * whether a specific code exists, and the referral just becomes
 * unattributed.
 */
const COOKIE_NAME = "yven_ref";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const clean = String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);

  const url = req.nextUrl.clone();
  url.pathname = "/signup";
  url.search = "";

  const res = NextResponse.redirect(url);

  if (clean) {
    // Best-effort — validate the code exists but redirect either way.
    const found = await findReferralByCode(clean).catch(() => null);
    if (found) {
      res.cookies.set({
        name: COOKIE_NAME,
        value: clean,
        maxAge: COOKIE_MAX_AGE,
        path: "/",
        sameSite: "lax",
        httpOnly: false, // client + register route both read it
        secure: req.nextUrl.protocol === "https:",
      });
    }
  }

  return res;
}
