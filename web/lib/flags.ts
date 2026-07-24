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

const DEFAULTS: Flags = {
  auth_v2_enabled: false,
  tenant_filter_enforced: false,
  signup_open: false,
  quotas_enforced: false,
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
  } catch {
    // Fail closed — return defaults (all OFF) so gated features don't
    // accidentally activate when PB is unreachable.
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
