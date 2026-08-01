import { adminDb } from "@/lib/firebase-admin";

/**
 * YouTube connection health.
 *
 * A stored refresh token can stop working at any moment — the user
 * changes their Google password, revokes app access, or Google expires
 * it. Nothing in the product noticed. The first symptom was a render
 * burning ~20 minutes of GPU and then failing at the upload step, and
 * even then only the operator saw it in a Discord message. A live
 * check on 2026-08-01 found one of nine accounts had been dead for
 * weeks with no indication anywhere in the UI.
 *
 * The only definitive test is to actually exchange the refresh token
 * with Google. Anything cheaper (checking expiry timestamps, assuming
 * the last successful upload means it still works) gives false
 * confidence, because revocation is instant and carries no signal.
 */

export type HealthStatus = "ok" | "dead" | "error" | "unknown";

export type AccountHealth = {
  id: string;
  title: string;
  status: HealthStatus;
  error: string;
  checked_at: number;
  failures: number;
};

/** A single failure shouldn't be reported to a customer as "your
 *  channel is disconnected" — Google's token endpoint has transient
 *  5xx and network timeouts. Only invalid_grant is unambiguous. */
const FAILURES_BEFORE_DEAD = 2;

type Creds = {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
};

/**
 * Probe one account. Returns the status WITHOUT writing — callers
 * decide whether to persist, so a read-only status view can't
 * accidentally mutate state.
 */
export async function probeAccount(
  credentialsJson: string,
): Promise<{ status: HealthStatus; error: string }> {
  let creds: Creds;
  try {
    creds = JSON.parse(credentialsJson || "{}");
  } catch {
    return { status: "dead", error: "Stored credentials are corrupt — reconnect required." };
  }
  if (!creds.refresh_token || !creds.client_id || !creds.client_secret) {
    return { status: "dead", error: "No refresh token stored — reconnect required." };
  }

  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(12_000),
    });

    if (r.ok) {
      const j = await r.json();
      // A token that refreshes but can't read the channel is still
      // broken from the product's point of view (scope revoked,
      // channel deleted), so verify the actual capability we need.
      const c = await fetch(
        "https://youtube.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${j.access_token}` }, signal: AbortSignal.timeout(12_000) },
      );
      if (c.ok) return { status: "ok", error: "" };
      return {
        status: "error",
        error: `Signed in, but YouTube returned ${c.status} when reading the channel.`,
      };
    }

    const e = await r.json().catch(() => ({} as { error?: string }));
    // invalid_grant is definitive: the user revoked access or changed
    // their password. Everything else may be transient.
    if (e.error === "invalid_grant") {
      return { status: "dead", error: "Access was revoked or expired. Reconnect this channel." };
    }
    return { status: "error", error: `Google returned ${e.error || r.status}.` };
  } catch (err) {
    return { status: "error", error: `Couldn't reach Google (${String(err).slice(0, 60)}).` };
  }
}

/**
 * Probe every account belonging to `userId` (or all, when omitted for
 * the maintenance sweep) and persist the result.
 *
 * Consecutive failures are counted so a transient error doesn't flip a
 * working channel to "disconnected" in the customer's UI on one bad
 * network round trip.
 */
export async function checkAccounts(opts: {
  userId?: string;
  persist?: boolean;
} = {}): Promise<AccountHealth[]> {
  const { userId, persist = true } = opts;

  let q = adminDb().collection("youtube_accounts").limit(200);
  if (userId) q = q.where("user_id", "==", userId);
  const snap = await q.get();

  const now = Math.floor(Date.now() / 1000);
  const out: AccountHealth[] = [];

  for (const doc of snap.docs) {
    const d = (doc.data() || {}) as Record<string, unknown>;
    const prevFailures = Number(d.health_failures || 0);

    const { status, error } = await probeAccount(String(d.credentials || ""));

    // Only "dead" is trusted immediately; "error" needs to repeat
    // before it's surfaced as a broken connection.
    let failures = status === "ok" ? 0 : prevFailures + 1;
    let effective: HealthStatus = status;
    if (status === "error" && failures < FAILURES_BEFORE_DEAD) {
      // Keep showing the previous state while we're unsure.
      effective = (String(d.health_status || "ok") as HealthStatus) || "ok";
    }

    if (persist) {
      try {
        await doc.ref.set({
          health_status: effective,
          health_checked_at: now,
          health_error: effective === "ok" ? "" : error.slice(0, 300),
          health_failures: failures,
        }, { merge: true });
      } catch {
        // Health tracking must never break the caller.
      }
    }

    out.push({
      id: doc.id,
      title: String(d.title || "(unnamed)"),
      status: effective,
      error: effective === "ok" ? "" : error,
      checked_at: now,
      failures,
    });
  }

  return out;
}
