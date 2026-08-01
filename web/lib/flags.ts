/**
 * Feature flag reader — reads the `settings/ktt7sdazit7wnsk` singleton
 * created by migration 0016 and caches the result for 30s. All Phase-1+
 * gated code paths read via `getFlag(name)`.
 *
 * Read-heavy, write-almost-never: superadmin toggles a flag in the UI
 * (Phase 6) → PB write → next 30s of reads pick it up. No restart.
 *
 * Fails-closed on read errors: if PB is down the flag reads as `false`,
 * so gated features stay off rather than accidentally activate.
 */
import { adminDb } from "@/lib/firebase-admin";

const FLAGS_DOC_ID = "ktt7sdazit7wnsk"; // _pbId("flags") — see migration 0016
const CACHE_TTL_MS = 30_000;

type Flags = {
  auth_v2_enabled: boolean;
  tenant_filter_enforced: boolean;
  signup_open: boolean;
  quotas_enforced: boolean;
  shared_pool_enabled: boolean;
  landing_cms_enabled: boolean;
};

/**
 * Two different kinds of flag live in here, and they have OPPOSITE
 * safe defaults. Conflating them was a real vulnerability:
 *
 *   SECURITY flags gate isolation. For these, `false` is the OPEN,
 *   dangerous state — no tenant filtering, no quota enforcement. They
 *   MUST default to true, so an unreachable PocketBase degrades into
 *   "everything locked down" rather than "everyone sees everything".
 *
 *   FEATURE flags gate functionality. For these, `false` is the safe
 *   state — a half-built feature stays hidden.
 *
 * Before this split, a transient PB failure on a cold process (no
 * cache yet) silently turned the app into a shared-everything space:
 * tenantWhereClauses() returned [], assertOwnership() short-circuited
 * to allow, and the claim gate was skipped — with no log line.
 */
const DEFAULTS: Flags = {
  // ── security: default ON (fail closed) ──────────────────────────
  tenant_filter_enforced: true,
  quotas_enforced: true,
  // ── features: default OFF (fail hidden) ─────────────────────────
  auth_v2_enabled: false,
  signup_open: false,
  shared_pool_enabled: false,
  landing_cms_enabled: false,
};

let _cached: { at: number; value: Flags } | null = null;

export async function getFlags(): Promise<Flags> {
  if (_cached && Date.now() - _cached.at < CACHE_TTL_MS) return _cached.value;
  try {
    const snap = await adminDb().collection("settings").doc(FLAGS_DOC_ID).get();
    if (!snap.exists) {
      _cached = { at: Date.now(), value: DEFAULTS };
      return DEFAULTS;
    }
    const raw = (snap.data() as { data?: unknown } | undefined)?.data;
    const parsed: Partial<Flags> =
      typeof raw === "string" ? JSON.parse(raw) :
      raw && typeof raw === "object" ? (raw as Partial<Flags>) :
      {};
    const merged: Flags = { ...DEFAULTS, ...parsed };
    _cached = { at: Date.now(), value: merged };
    return merged;
  } catch (e) {
    // Prefer last-known-good; otherwise the DEFAULTS above, which keep
    // isolation ON. Logged at error level because a flag read failing
    // means every gate in the app is running on fallback values, and
    // that previously happened completely silently.
    console.error("[flags] read failed — using", _cached ? "last-known-good" : "safe defaults", e);
    return _cached?.value ?? DEFAULTS;
  }
}

export async function getFlag<K extends keyof Flags>(name: K): Promise<Flags[K]> {
  const f = await getFlags();
  return f[name];
}

/** Bust the cache — call from the /superadmin/flags edit route so a
 *  toggle takes effect on the very next request. */
export function _bustFlagsCache(): void { _cached = null; }
