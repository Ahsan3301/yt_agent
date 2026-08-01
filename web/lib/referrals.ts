import { adminDb, FieldValue } from "@/lib/firebase-admin";

/**
 * Referral helpers.
 *
 * Model:
 *   - Every active user gets ONE referral row in `referrals` with a
 *     short hex code, unique across users.
 *   - Every attributed signup lands in `referral_signups` with
 *     status="signed_up". When the referred user completes approval,
 *     status flips to "joined" and joined_at is stamped.
 *   - The 5-friend unlock semantic is derived: count of
 *     status="joined" rows for a given referrer_user_id. When it
 *     first crosses THRESHOLD, `unlocked_at` is stamped on the
 *     referrer's referrals row — that's the trigger for "unlock trial"
 *     behaviour (plan flip / feature access — up to callers to consume).
 */

export const UNLOCK_THRESHOLD = 5;

/** Short unique code — hex, 10 chars, ~1 trillion values, ambiguous
 *  chars stripped so users can eyeball type it. */
function _makeCode(): string {
  const chars = "abcdefghjkmnpqrstuwxyz23456789"; // no 0/o/l/1/i/v — visually clean
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function _codeUnique(code: string): Promise<boolean> {
  const snap = await adminDb().collection("referrals")
    .where("code", "==", code).limit(1).get();
  return snap.empty;
}

/** Return the user's referral row, creating one on first call.
 *  Idempotent — safe to call repeatedly. */
export async function getOrCreateReferral(userId: string): Promise<{
  user_id: string;
  code: string;
  created_at: number;
  unlocked_at?: number;
}> {
  const coll = adminDb().collection("referrals");
  const existing = await coll.where("user_id", "==", userId).limit(1).get();
  if (!existing.empty) {
    const d = existing.docs[0].data() as {
      user_id: string; code: string; created_at: number; unlocked_at?: number;
    };
    return d;
  }
  // Generate a code, retry up to 6 times on collision.
  let code = "";
  for (let i = 0; i < 6; i++) {
    const candidate = _makeCode();
    if (await _codeUnique(candidate)) { code = candidate; break; }
  }
  if (!code) throw new Error("could not allocate referral code after 6 attempts");
  const now = Math.floor(Date.now() / 1000);
  const row = { user_id: userId, code, created_at: now };
  // The PB adapter has no .add() — use .doc() with no arg for auto-id.
  await coll.doc().set(row);
  return row;
}

export async function findReferralByCode(code: string): Promise<{
  user_id: string; code: string; created_at: number;
} | null> {
  const snap = await adminDb().collection("referrals")
    .where("code", "==", code).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data() as { user_id: string; code: string; created_at: number };
}

/** Attribute a new signup to a referrer. Idempotent per referred user id. */
export async function attributeSignup(referrerUserId: string, referredUserId: string, referredEmail: string): Promise<void> {
  const coll = adminDb().collection("referral_signups");
  const existing = await coll.where("referred_user_id", "==", referredUserId).limit(1).get();
  if (!existing.empty) return;
  await coll.doc().set({
    referrer_user_id: referrerUserId,
    referred_user_id: referredUserId,
    referred_email:   referredEmail,
    status:           "signed_up",
    created_at:       Math.floor(Date.now() / 1000),
  });
}

/** Called from the approve route. Flips any matching signup row to
 *  "joined" and, if the referrer just crossed the threshold, stamps
 *  unlocked_at on their referral row.
 *  Returns { joinedCount, unlocked } for the referrer, or null if
 *  the referred user wasn't attributed to anyone. */
export async function markJoinedAndCheckUnlock(referredUserId: string): Promise<{
  referrerUserId: string;
  joinedCount: number;
  newlyUnlocked: boolean;
} | null> {
  const signups = adminDb().collection("referral_signups");
  const snap = await signups.where("referred_user_id", "==", referredUserId).limit(1).get();
  if (snap.empty) return null;
  const rowDoc = snap.docs[0];
  const row = rowDoc.data() as { referrer_user_id: string; status: string };
  const now = Math.floor(Date.now() / 1000);
  if (row.status !== "joined") {
    await rowDoc.ref.set({ status: "joined", joined_at: now }, { merge: true });
  }
  const referrerUserId = row.referrer_user_id;

  // Count joined for the referrer.
  const joinedSnap = await signups
    .where("referrer_user_id", "==", referrerUserId)
    .where("status", "==", "joined")
    .get();
  const joinedCount = joinedSnap.size;

  let newlyUnlocked = false;
  if (joinedCount >= UNLOCK_THRESHOLD) {
    const refRows = await adminDb().collection("referrals")
      .where("user_id", "==", referrerUserId).limit(1).get();
    if (!refRows.empty && !(refRows.docs[0].data() as { unlocked_at?: number }).unlocked_at) {
      await refRows.docs[0].ref.set({ unlocked_at: now }, { merge: true });
      newlyUnlocked = true;
    }
  }

  return { referrerUserId, joinedCount, newlyUnlocked };
}

/** Referral dashboard payload for /api/referrals/me. */
export async function getReferralStatsFor(userId: string): Promise<{
  code: string;
  share_url_path: string;
  joined_count: number;
  signed_up_count: number;
  signups: Array<{ email: string; status: string; created_at: number; joined_at?: number }>;
  unlocked: boolean;
  unlocked_at?: number;
  threshold: number;
}> {
  const row = await getOrCreateReferral(userId);
  const snap = await adminDb().collection("referral_signups")
    .where("referrer_user_id", "==", userId)
    .orderBy("created_at", "desc")
    .get();
  const signups = snap.docs.map((d) => {
    const x = d.data() as { referred_email?: string; status?: string; created_at?: number; joined_at?: number };
    return {
      email:      String(x.referred_email || ""),
      status:     String(x.status || "signed_up"),
      created_at: Number(x.created_at || 0),
      joined_at:  x.joined_at ? Number(x.joined_at) : undefined,
    };
  });
  const joined = signups.filter((s) => s.status === "joined").length;
  return {
    code: row.code,
    share_url_path: `/r/${row.code}`,
    joined_count: joined,
    signed_up_count: signups.filter((s) => s.status === "signed_up").length,
    signups,
    unlocked: !!row.unlocked_at,
    unlocked_at: row.unlocked_at,
    threshold: UNLOCK_THRESHOLD,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _keep = FieldValue;
