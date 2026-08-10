import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { sendMail, formatSubmission } from "@/lib/mailer";
import { getConfig } from "@/lib/platform-config";

/**
 * Shared handling for the public inbound forms (contact, quote request,
 * custom niche request).
 *
 * They differ only in which extra fields they carry, so the parts that
 * are easy to get subtly wrong — email validation, spam guards, size
 * limits, dedupe, notification, and above all what happens when
 * notification fails — live here once instead of being reimplemented
 * three times with three different bugs.
 *
 * The ordering rule throughout: SAVE FIRST, NOTIFY SECOND, and never
 * let a notification failure fail the request. A visitor who fills in a
 * form has done their part; if our mail server is misconfigured that is
 * our problem to discover (via the `notified` column and the test-email
 * button), not theirs to be told about.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim, collapse whitespace, hard-cap length. */
export function clean(v: unknown, max: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Same as clean() but keeps newlines — for message bodies. */
export function cleanMultiline(v: unknown, max: number): string {
  return String(v ?? "").replace(/[ \t]+/g, " ").trim().slice(0, max);
}

export type InboundSpec = {
  /** PocketBase collection to write to. */
  collection: string;
  /** Human label used in the notification subject, e.g. "Quote request". */
  kind: string;
  /** Extra fields beyond name/email/message, already cleaned. */
  extra: Record<string, string>;
  name: string;
  email: string;
  message: string;
  /** Honeypot field value — non-empty means a bot filled a hidden input. */
  honeypot?: string;
};

export async function handleInbound(
  req: NextRequest,
  spec: InboundSpec,
): Promise<NextResponse> {
  const { collection, kind, extra, name, email, message, honeypot } = spec;

  // Honeypot: a hidden input no human sees. Return success rather than
  // an error — telling a bot it was detected just invites a retry with
  // the field left blank.
  if (honeypot && honeypot.trim()) {
    return NextResponse.json({ ok: true });
  }

  if (!email || !EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json(
      { error: "Please enter a valid email address so we can reply." },
      { status: 400 },
    );
  }
  if (!name) {
    return NextResponse.json({ error: "Please tell us your name." }, { status: 400 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim().slice(0, 64) ||
    req.headers.get("x-real-ip")?.slice(0, 64) || "";
  const ua = (req.headers.get("user-agent") || "").slice(0, 300);
  const now = Math.floor(Date.now() / 1000);

  // Light flood guard: same email, same collection, within 60s is
  // almost always a double-click or a retry, not a second enquiry.
  try {
    const recent = await adminDb().collection(collection)
      .where("email", "==", email).limit(5).get();
    const tooSoon = recent.docs.some((d) => {
      const t = Number((d.data() as { created_at?: number }).created_at || 0);
      return t > 0 && now - t < 60;
    });
    if (tooSoon) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  } catch { /* guard is best-effort — never block a genuine submission */ }

  const payload: Record<string, string | number | boolean> = {
    name, email, message,
    ...extra,
    status: "new",
    ip, user_agent: ua,
    notified: false,
    created_at: now,
  };

  let docId = "";
  try {
    const ref = adminDb().collection(collection).doc();
    await ref.set(payload);
    docId = ref.id;
  } catch (e) {
    // The only failure the visitor is told about, because it is the
    // only one where their message genuinely did not reach us.
    return NextResponse.json(
      { error: "Sorry — we couldn't save that. Please try again in a moment." },
      { status: 500 },
    );
  }

  // Notify. Deliberately awaited: serverless kills the process when the
  // response returns, so a fire-and-forget send would be cancelled
  // mid-flight often enough to be untrustworthy. The mailer's own 15s
  // timeouts bound the cost, and it never throws.
  const { subject, text } = formatSubmission(kind, { name, email, ...extra, message });
  const mail = await sendMail({ subject, text, replyTo: email });

  if (mail.ok && !mail.skipped) {
    try {
      await adminDb().collection(collection).doc(docId).set({ notified: true }, { merge: true });
    } catch { /* cosmetic — the message is already saved */ }
  } else if (!mail.ok) {
    // Worth a server log: this is how the operator finds out that mail
    // is broken without waiting for someone to complain.
    console.warn(`[inbound:${collection}] saved ${docId} but email failed: ${mail.error}`);
  }

  // Discord as a second channel when it is configured. Independent of
  // SMTP on purpose — with no mail server set up at all, this is still
  // a live notification path.
  void _pingDiscord(kind, { name, email, ...extra, message });

  return NextResponse.json({ ok: true });
}

async function _pingDiscord(kind: string, fields: Record<string, string>): Promise<void> {
  try {
    const url = (await getConfig("DISCORD_WEBHOOK_URL", "")).trim();
    if (!url) return;
    const lines = Object.entries(fields)
      .filter(([, v]) => v && v.trim())
      .map(([k, v]) => `**${k.replace(/_/g, " ")}:** ${v.slice(0, 300)}`);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `📥 **${kind}**\n${lines.join("\n")}`.slice(0, 1900) }),
    });
  } catch { /* notification is never worth failing a request over */ }
}
