import { NextRequest, NextResponse } from "next/server";
import { _signSession } from "@/middleware";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/auth/login  Body: { password }
 *  Verifies the password (constant-time compare) against
 *  DASHBOARD_PASSWORD env var. On success sets a signed HttpOnly
 *  cookie for 30 days. */
const COOKIE_TTL_DAYS = 30;

export async function POST(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD || "";
  if (!password) {
    // No password configured = auth disabled globally.
    return NextResponse.json({ ok: true, note: "auth disabled" });
  }
  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const given = String(body?.password || "");
  // Constant-time compare — avoids the (negligible in this context but
  // trivial to eliminate) timing side-channel.
  if (given.length !== password.length || !_ctEq(given, password)) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }
  const expiry = Date.now() + COOKIE_TTL_DAYS * 24 * 3600 * 1000;
  const cookie = await _signSession(`v1:${expiry}`, password);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("dash_auth", cookie, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   COOKIE_TTL_DAYS * 24 * 3600,
  });
  return res;
}

function _ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
