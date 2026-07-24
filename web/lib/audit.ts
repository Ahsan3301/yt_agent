/**
 * Append-only audit log helper. Every superadmin action, every admin
 * user-state change, every impersonated write ends up here.
 *
 * Never surfaced to non-admins. Retention is unbounded today; a
 * later phase can add a cron sweep with a >1yr threshold.
 */
import { adminDb } from "@/lib/firebase-admin";
import type { Session } from "@/lib/session";

export interface AuditEntry {
  action: string;                 // e.g. "user.approve", "content.save"
  target_type: string;            // e.g. "app_users", "landing_content"
  target_id: string;
  meta?: Record<string, unknown>;
}

/** Fire-and-forget audit write. Never throws — auditing must never
 *  break the primary action. */
export async function audit(
  session: Session,
  entry: AuditEntry,
  req?: Request,
): Promise<void> {
  try {
    const ip = req?.headers.get("x-forwarded-for")?.split(",")[0].trim()
      || req?.headers.get("cf-connecting-ip")
      || "";
    const ua = req?.headers.get("user-agent") || "";
    const doc = {
      ts: Math.floor(Date.now() / 1000),
      actor_user_id: session.userId,
      impersonated_user_id: session.impersonating ? "" : "",
      action: entry.action.slice(0, 64),
      target_type: entry.target_type.slice(0, 32),
      target_id: entry.target_id.slice(0, 64),
      meta: entry.meta || {},
      ip: ip.slice(0, 64),
      user_agent: ua.slice(0, 400),
    };
    // .doc() with no id → auto-id (Firestore parity in the PB shim).
    await adminDb().collection("audit_log").doc().set(doc);
  } catch {
    // Silent — see JSDoc.
  }
}
