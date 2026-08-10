import nodemailer from "nodemailer";
import { getConfigMany } from "@/lib/platform-config";

/**
 * SMTP delivery for outbound notifications.
 *
 * Two rules shape this file:
 *
 * 1. CONFIG IS READ AT SEND TIME. No module-level transport, no cached
 *    credentials. The operator can paste SMTP settings into
 *    /superadmin/config and the very next email uses them — no restart,
 *    no redeploy. A transport built at import time would have meant
 *    "save the settings, then redeploy to use them", which is exactly
 *    the kind of hidden step that makes a feature look broken.
 *
 * 2. NOT CONFIGURED IS A NORMAL STATE, NOT AN ERROR. Every caller here
 *    is a public form. If SMTP is blank, the submission must still be
 *    saved and the visitor must still see success — losing a customer
 *    enquiry because the operator hasn't set up mail yet would be far
 *    worse than not getting the email. sendMail() returns a result
 *    object and never throws; callers record `notified` so the operator
 *    can tell "nobody contacted us" from "we failed to tell you".
 */

export type MailResult =
  | { ok: true; skipped: false; messageId: string }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; skipped: false; error: string };

const SMTP_KEYS = [
  "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE",
  "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_TO",
] as const;

type SmtpConfig = {
  host: string; port: number; secure: boolean;
  user: string; pass: string; from: string; to: string;
};

/** Resolve SMTP settings from platform config. Null when unusable. */
async function _resolve(): Promise<SmtpConfig | null> {
  const c = await getConfigMany([...SMTP_KEYS]);
  const host = (c.SMTP_HOST || "").trim();
  if (!host) return null;                 // the deliberate off switch

  const port = Number((c.SMTP_PORT || "").trim() || 587) || 587;
  const user = (c.SMTP_USER || "").trim();
  const pass = (c.SMTP_PASSWORD || "").trim();
  // Implicit TLS is the exception (465). Accept the port as a signal
  // too — an operator who sets 465 and forgets the checkbox should get
  // a working connection, not a confusing timeout.
  const secure =
    /^(1|true|yes)$/i.test((c.SMTP_SECURE || "").trim()) || port === 465;

  const from = (c.SMTP_FROM || "").trim() || user;
  if (!from) return null;                 // nothing valid to put in From:
  const to = (c.SMTP_TO || "").trim() || from;

  return { host, port, secure, user, pass, from, to };
}

/** True when a host is configured — used to show setup state in the UI. */
export async function mailerConfigured(): Promise<boolean> {
  return (await _resolve()) !== null;
}

export type SendArgs = {
  subject: string;
  text: string;
  html?: string;
  to?: string;          // defaults to SMTP_TO
  replyTo?: string;     // the enquirer, so Reply just works
};

/**
 * Send one message. Never throws.
 *
 * The 15s timeouts matter: this runs inside a form POST, and a mail
 * server that accepts the TCP connection then stalls would otherwise
 * hold the visitor's request open until the platform's own timeout,
 * making a working form look broken.
 */
export async function sendMail(args: SendArgs): Promise<MailResult> {
  let cfg: SmtpConfig | null;
  try {
    cfg = await _resolve();
  } catch (e) {
    return { ok: false, skipped: false, error: `config read failed: ${String(e).slice(0, 200)}` };
  }
  if (!cfg) {
    return { ok: true, skipped: true, reason: "SMTP not configured" };
  }

  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      // Omit auth entirely for relays that don't want it — passing
      // {user:"",pass:""} makes some servers reject the session.
      ...(cfg.user || cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
    });

    const info = await transport.sendMail({
      from: cfg.from,
      to: args.to || cfg.to,
      subject: args.subject,
      text: args.text,
      ...(args.html ? { html: args.html } : {}),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    });
    return { ok: true, skipped: false, messageId: String(info.messageId || "") };
  } catch (e) {
    return { ok: false, skipped: false, error: String(e).slice(0, 300) };
  }
}

/**
 * Verify the SMTP settings without delivering anything to a customer.
 * Backs the "Send test email" button so the operator finds out the
 * password is wrong at setup time rather than when the first real
 * enquiry silently fails to arrive.
 */
export async function verifyAndTest(): Promise<
  { ok: boolean; detail: string; sentTo?: string }
> {
  const cfg = await _resolve();
  if (!cfg) {
    return { ok: false, detail: "SMTP host is not set — fill in the fields above and save first." };
  }
  const res = await sendMail({
    subject: "Yven SMTP test",
    text:
      "This is a test from your Yven dashboard.\n\n" +
      "If you are reading this, contact form, quote request and custom niche " +
      "request notifications will reach you at this address.\n\n" +
      `Server: ${cfg.host}:${cfg.port} (${cfg.secure ? "TLS" : "STARTTLS"})\n` +
      `From:   ${cfg.from}\n`,
  });
  if (res.ok && !res.skipped) {
    return { ok: true, detail: `Sent to ${cfg.to}. Check that inbox (and its spam folder).`, sentTo: cfg.to };
  }
  if (res.ok && res.skipped) {
    return { ok: false, detail: res.reason };
  }
  return { ok: false, detail: res.error };
}

/**
 * Format one inbound form submission as an email.
 *
 * Plain text on purpose: these go to an operator's inbox, they need to
 * be skimmable on a phone, and HTML mail from a new domain is more
 * likely to be filtered.
 */
export function formatSubmission(
  kind: string,
  fields: Record<string, string | undefined>,
): { subject: string; text: string } {
  const rows = Object.entries(fields)
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v).trim()}`);
  const who = fields.email || fields.name || "someone";
  return {
    subject: `[Yven] ${kind} — ${who}`,
    text: `New ${kind.toLowerCase()} from the website.\n\n${rows.join("\n")}\n`,
  };
}
