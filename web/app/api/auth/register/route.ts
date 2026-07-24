import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { hashPassword } from "@/lib/passwords";
import { getFlag } from "@/lib/flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/register
 *
 * Body: { email, password, kaggle_username?, kaggle_key? }
 *
 * Creates an app_users row in status="pending", plan_id="free".
 * Gated by the `signup_open` flag — returns 403 if the operator hasn't
 * opened public signups yet.
 *
 * Waitlist model: the user is created but CANNOT log in until a
 * superadmin approves them via /admin/users (Phase 4). Sends a Discord
 * notification to the operator when a signup lands.
 */
export async function POST(req: NextRequest) {
  const open = await getFlag("signup_open");
  if (!open) {
    return NextResponse.json(
      { error: "signups are closed — please contact the operator for access" },
      { status: 403 },
    );
  }

  let body: { email?: string; password?: string; kaggle_username?: string; kaggle_key?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const kaggleUsername = String(body?.kaggle_username || "").trim();
  const kaggleKey = String(body?.kaggle_key || "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }
  if (!password || password.length < 10) {
    return NextResponse.json(
      { error: "password must be at least 10 characters" }, { status: 400 },
    );
  }
  if (email.length > 320) {
    return NextResponse.json({ error: "email too long" }, { status: 400 });
  }
  if (password.length > 200) {
    return NextResponse.json({ error: "password too long" }, { status: 400 });
  }

  // Reject duplicate email early with a friendlier error than the PB
  // unique-index violation.
  try {
    const existing = await adminDb().collection("app_users")
      .where("email", "==", email).limit(1).get();
    if (!existing.empty) {
      return NextResponse.json(
        { error: "an account with this email already exists" }, { status: 409 },
      );
    }
  } catch {
    // If the pre-check fails, PB's unique index will still catch dupes
    // on insert; just log and continue.
  }

  const password_hash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);

  const userId = _shortUserId();
  try {
    await adminDb().collection("app_users").doc(userId).set({
      id: userId,
      email,
      password_hash,
      role: "user",
      status: "pending",
      plan_id: "free",
      kaggle_username: kaggleUsername.slice(0, 80),
      kaggle_key: kaggleKey.slice(0, 200),
      created_at: now,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "signup failed — please try again", detail: String(e).slice(0, 200) },
      { status: 500 },
    );
  }

  // Fire-and-forget Discord ping via the existing worker notifier
  // shim. Uses the global webhook stored at settings/api_keys.
  _pingOperatorAsync({ userId, email, hasKaggle: !!kaggleUsername });

  return NextResponse.json({
    ok: true,
    status: "pending",
    message: "account created — a superadmin will review your signup shortly.",
  });
}

/** Short PB-valid user id: "u_" + 13 [a-z0-9]. Prefix marks the row
 *  provenance and keeps ids readable in logs. */
function _shortUserId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "u_";
  for (let i = 0; i < 13; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Best-effort operator ping. Reads the DISCORD_WEBHOOK from the same
 *  settings/api_keys blob every other notifier hits. Never throws. */
async function _pingOperatorAsync(payload: { userId: string; email: string; hasKaggle: boolean }): Promise<void> {
  try {
    const snap = await adminDb().collection("settings").doc("denauf3tmivtzyg").get();
    if (!snap.exists) return;
    const blob = (snap.data() as { data?: unknown } | undefined)?.data;
    const parsed: Record<string, string> =
      typeof blob === "string" ? JSON.parse(blob) :
      blob && typeof blob === "object" ? (blob as Record<string, string>) : {};
    const webhook = String(parsed.DISCORD_WEBHOOK || "").trim();
    if (!webhook) return;
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "🆕 New signup — waiting for approval",
          description:
            `**Email:** ${payload.email}\n` +
            `**User ID:** \`${payload.userId}\`\n` +
            `**Kaggle key supplied:** ${payload.hasKaggle ? "yes" : "no"}\n\n` +
            "Approve at /admin/users (available once Phase 4 ships).",
          color: 0x22C55E,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch { /* silent */ }
}
