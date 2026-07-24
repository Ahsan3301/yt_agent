import { NextRequest, NextResponse } from "next/server";
import { signSessionV1, signSessionV2, COOKIE_MAX_AGE_SECONDS, type UserRole } from "@/lib/session";
import { findAppUserByEmail } from "@/lib/auth";
import { verifyPassword } from "@/lib/passwords";
import { getFlag } from "@/lib/flags";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/login
 *
 * Dual-mode. Accepts EITHER:
 *   { password }                 — legacy single-master-password login.
 *                                   Verifies against DASHBOARD_PASSWORD env.
 *                                   Issues a v1 cookie -> synthetic
 *                                   founder session. Works only while
 *                                   auth_v2_enabled is false OR the
 *                                   provided password matches the env
 *                                   (allows the founder to still recover
 *                                   even after cutover).
 *
 *   { email, password }          — new user-bound login. Looks up
 *                                   app_users by email, scrypt-verifies
 *                                   password_hash, checks status=active,
 *                                   issues a v2:<userId>:<role>:... cookie.
 *
 * Success sets `dash_auth` HttpOnly cookie for 30 days.
 */
export async function POST(req: NextRequest) {
  let body: { password?: string; email?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const password = String(body?.password || "");
  const email    = String(body?.email    || "").trim().toLowerCase();

  // ── Path A: email + password (v2) ─────────────────────────────
  if (email && password) {
    const user = await findAppUserByEmail(email);
    if (!user) {
      return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    }
    const status = String(user.status || "");
    if (status === "pending") {
      return NextResponse.json(
        { error: "account pending admin approval" }, { status: 403 },
      );
    }
    if (status === "suspended") {
      return NextResponse.json(
        { error: "account suspended — contact support" }, { status: 403 },
      );
    }
    const hash = String(user.password_hash || "");
    const ok   = hash ? await verifyPassword(password, hash) : false;
    if (!ok) {
      return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    }
    const role = (["user", "admin", "superadmin"].includes(String(user.role))
      ? user.role : "user") as UserRole;
    const cookie = await signSessionV2(String(user.id), role);
    // Best-effort last_login_at update; don't block login on failure.
    try {
      await adminDb().collection("app_users").doc(String(user.id))
        .set({ last_login_at: Math.floor(Date.now() / 1000) }, { merge: true });
    } catch { /* non-fatal */ }
    return _setCookie(NextResponse.json({ ok: true, role, mode: "v2" }), cookie);
  }

  // ── Path B: legacy master password (v1) ───────────────────────
  const envPw = process.env.DASHBOARD_PASSWORD || "";
  if (!envPw) {
    // No master password configured AND caller didn't supply email/pw
    // -> nothing to authenticate against.
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  if (!_ctEq(password, envPw)) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  // Legacy login remains a permanent break-glass for the founder even
  // after auth_v2_enabled flips true — the master password only they
  // hold guarantees they never lose access if the app_users row is
  // damaged. Warn if v2 is on so we can spot legacy use in logs.
  if (await getFlag("auth_v2_enabled")) {
    console.log(JSON.stringify({
      msg: "login v1 (legacy) used while auth_v2_enabled=true",
    }));
  }
  const cookie = await signSessionV1();
  return _setCookie(NextResponse.json({ ok: true, mode: "v1" }), cookie);
}

function _setCookie(res: NextResponse, cookie: string): NextResponse {
  res.cookies.set("dash_auth", cookie, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

function _ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
