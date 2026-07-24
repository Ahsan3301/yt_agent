/**
 * Plan quota enforcement helpers.
 *
 * A route calls `requirePlanQuota(userId, kind)` before creating a
 * new channel or submitting a render. When enforcement is on AND the
 * user is on a capped plan, over-limit calls return a 429-shaped
 * response the route surfaces verbatim.
 *
 * Founder plan and superadmin role always bypass. `tenant_filter_enforced`
 * flag controls whether tenancy applies (Phase 2); `quotas_enforced`
 * flag independently controls whether quotas fire (Phase 5). Both
 * default off — the founder never gets blocked.
 *
 * Values of 0 OR null on a plan's max_* field mean "unlimited" — the
 * founder plan uses 0 for both, so 0-as-unlimited is the compat rule.
 * Explicit caps must be a positive integer.
 *
 * Cached 60s per (userId, kind) so a busy dashboard poll doesn't spam
 * PB. Cache is bumped by `_bustQuotaCache(userId)` from write paths
 * so the count reflects the very next request.
 */
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { getFlag } from "@/lib/flags";
import type { Tenant } from "@/lib/tenant";

export type QuotaKind = "channels" | "renders_month";

const CACHE_TTL_MS = 60_000;
type CacheEntry = { at: number; used: number };
const _cache = new Map<string, CacheEntry>();

/** Fetch the user's plan doc. Returns null when no plan slug is set
 *  (treated as unlimited — pre-Phase-5 users). */
async function _resolvePlan(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const user = await adminDb().collection("app_users").doc(userId).get();
    if (!user.exists) return null;
    const slug = String((user.data() || {}).plan_id || "").trim();
    if (!slug) return null;
    const q = await adminDb().collection("plans").where("slug", "==", slug).limit(1).get();
    if (q.empty) return null;
    const doc = q.docs[0];
    return doc.data() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function _countChannels(userId: string): Promise<number> {
  try {
    const snap = await adminDb().collection("channels")
      .where("user_id", "==", userId).limit(500).get();
    return snap.size;
  } catch {
    return 0;
  }
}

/** Count non-cancelled render jobs the user submitted this UTC month. */
async function _countRendersThisMonth(userId: string): Promise<number> {
  try {
    const now = new Date();
    const startOfMonth = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const snap = await adminDb().collection("jobs")
      .where("user_id", "==", userId).limit(2000).get();
    let n = 0;
    snap.forEach((doc) => {
      const d = doc.data() as { queued_at?: number; status?: string; kind?: string };
      if (Number(d.queued_at || 0) < startOfMonth) return;
      if (d.status === "cancelled") return;
      // Only count RENDER jobs — publish_youtube / copy_storage side-jobs
      // don't count against the render quota.
      if (d.kind && d.kind !== "render") return;
      n += 1;
    });
    return n;
  } catch {
    return 0;
  }
}

/** True when the plan's cap for `kind` is unlimited (null / 0). */
function _isUnlimited(plan: Record<string, unknown> | null, kind: QuotaKind): boolean {
  if (!plan) return true;
  const key = kind === "channels" ? "max_channels" : "max_renders_month";
  const v = plan[key];
  if (v == null) return true;
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0;
}

/**
 * Route-level guard. Returns null when the caller is allowed to proceed;
 * returns a NextResponse (429) when they've exceeded their plan's cap
 * for the given resource. Route handlers should `return` the response
 * verbatim.
 *
 * Bypass conditions:
 *   - `quotas_enforced` flag is off
 *   - tenant is superadmin
 *   - user's plan has max_<kind> = 0 or null (unlimited)
 */
export async function requirePlanQuota(
  tenant: Tenant, kind: QuotaKind,
): Promise<NextResponse | null> {
  if (tenant.isSuper) return null;
  const on = await getFlag("quotas_enforced");
  if (!on) return null;

  const plan = await _resolvePlan(tenant.userId);
  if (_isUnlimited(plan, kind)) return null;

  const cap = Number(plan![kind === "channels" ? "max_channels" : "max_renders_month"] as number);
  const cacheKey = `${tenant.userId}|${kind}`;
  const cached = _cache.get(cacheKey);
  let used: number;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    used = cached.used;
  } else {
    used = kind === "channels"
      ? await _countChannels(tenant.userId)
      : await _countRendersThisMonth(tenant.userId);
    _cache.set(cacheKey, { at: Date.now(), used });
  }

  if (used >= cap) {
    return NextResponse.json({
      error: kind === "channels"
        ? `channel limit reached — your plan allows ${cap} channel(s), you have ${used}`
        : `monthly render limit reached — your plan allows ${cap} render(s)/month, you have ${used}`,
      quota_kind: kind, cap, used,
    }, { status: 429 });
  }
  return null;
}

/** Invalidate the cache after a successful create so the next check
 *  reflects the new count. Call from POST handlers right after write. */
export function bustQuotaCache(userId: string, kind?: QuotaKind): void {
  if (!kind) {
    for (const k of _cache.keys()) if (k.startsWith(`${userId}|`)) _cache.delete(k);
  } else {
    _cache.delete(`${userId}|${kind}`);
  }
}
