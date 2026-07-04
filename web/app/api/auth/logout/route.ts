import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/auth/logout — clears the dash_auth cookie. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("dash_auth", "", {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   0,
  });
  return res;
}
