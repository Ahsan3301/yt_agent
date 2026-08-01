import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/marketing/demo/waitlist
 *
 * Public — accepts a signup from /demo. Persists to `demo_waitlist`
 * and fires a Discord notification via the same webhook the register
 * route uses.
 *
 * Rate-limit is intentionally light (per-request IP capture only) —
 * this endpoint is not enough traffic to justify a real bucket.
 */
export async function POST(req: NextRequest) {
  let body: { email?: string; first_name?: string; channel_url?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const email = String(body?.email || "").trim().toLowerCase();
  const first = String(body?.first_name || "").trim().slice(0, 80);
  const channel = String(body?.channel_url || "").trim().slice(0, 400);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "please enter a valid email" }, { status: 400 });
  }
  if (email.length > 320) {
    return NextResponse.json({ error: "email too long" }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim().slice(0, 64) ||
             req.headers.get("x-real-ip")?.slice(0, 64) || "";

  try {
    // Idempotency: same email → update the existing row instead of piling up.
    const dupe = await adminDb().collection("demo_waitlist")
      .where("email", "==", email).limit(1).get();
    const now = Math.floor(Date.now() / 1000);
    const payload = { email, first_name: first, channel_url: channel, ip, created_at: now };
    if (dupe.empty) {
      await adminDb().collection("demo_waitlist").add(payload);
    } else {
      await dupe.docs[0].ref.set(payload, { merge: true });
    }
  } catch (e) {
    return NextResponse.json(
      { error: "signup failed — please try again", detail: String(e).slice(0, 200) },
      { status: 500 },
    );
  }

  _pingDiscordAsync({ email, first, channel });

  return NextResponse.json({ ok: true });
}

async function _pingDiscordAsync(payload: { email: string; first: string; channel: string }): Promise<void> {
  try {
    // Same singleton blob the register route reads.
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
          title: "🎥 Demo waitlist signup",
          description:
            `**Email:** ${payload.email}\n` +
            (payload.first   ? `**Name:** ${payload.first}\n` : "") +
            (payload.channel ? `**Channel:** ${payload.channel}\n` : ""),
          color: 0xa78bfa,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch { /* silent */ }
}
