import { adminDb, FieldValue } from "@/lib/firebase-admin";

/**
 * Shared credential health.
 *
 * Since the platform pool went in, every tenant's renders run on the
 * operator's Groq / NIM / OpenRouter / Cloudflare / Stable Horde keys.
 * That turned a per-user annoyance into a single point of failure: one
 * expired key now breaks every customer simultaneously, and — exactly
 * like the YouTube token problem — an expired API key produces no
 * event. The provider just starts returning 401 mid-render.
 *
 * Each provider needs its own liveness check because none of them
 * share an auth convention. The probes below are all cheap, read-only
 * endpoints (list models, verify token, whoami) chosen to avoid
 * consuming generation quota just to ask "does this key work".
 */

export type KeyStatus = "ok" | "bad" | "error" | "unset";

export type KeyHealth = {
  key: string;
  status: KeyStatus;
  detail: string;
  /** For pooled multi-account credentials (Cloudflare), how many of
   *  the accounts in the pool are still usable. */
  working?: number;
  total?: number;
};

const TIMEOUT_MS = 12_000;
const HEALTH_DOC_ID = "pool_health";

async function get(url: string, headers: Record<string, string>) {
  return fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Map an HTTP response to a status. 401/403 is a genuinely bad key;
 *  anything else is more likely the provider having a bad day, and
 *  shouldn't cry wolf about a credential that's actually fine. */
function classify(status: number, okText = "reachable"): { status: KeyStatus; detail: string } {
  if (status >= 200 && status < 300) return { status: "ok", detail: okText };
  if (status === 401 || status === 403) {
    return { status: "bad", detail: `Rejected (HTTP ${status}) — key is invalid or revoked.` };
  }
  if (status === 429) {
    return { status: "ok", detail: "Rate-limited, but the key is valid." };
  }
  return { status: "error", detail: `Provider returned HTTP ${status}.` };
}

async function probeBearer(url: string, key: string): Promise<{ status: KeyStatus; detail: string }> {
  try {
    const r = await get(url, { Authorization: `Bearer ${key}` });
    return classify(r.status);
  } catch (e) {
    return { status: "error", detail: `Unreachable (${String(e).slice(0, 50)}).` };
  }
}

/** Cloudflare is a POOL of accounts, so partial failure is meaningful:
 *  three working accounts out of four still renders, one working out
 *  of four is about to. Report the ratio rather than a single bool. */
async function probeCloudflarePool(raw: string): Promise<KeyHealth> {
  let accounts: Array<{ label?: string; account_id?: string; api_token?: string }>;
  try {
    accounts = JSON.parse(raw);
    if (!Array.isArray(accounts)) throw new Error("not an array");
  } catch {
    return { key: "CLOUDFLARE_ACCOUNTS_JSON", status: "bad", detail: "Not valid JSON — image generation will be skipped." };
  }
  if (accounts.length === 0) {
    return { key: "CLOUDFLARE_ACCOUNTS_JSON", status: "unset", detail: "Empty pool." };
  }

  let working = 0;
  const broken: string[] = [];
  for (const acc of accounts) {
    if (!acc.api_token) { broken.push(acc.label || "?"); continue; }
    try {
      const r = await get("https://api.cloudflare.com/client/v4/user/tokens/verify",
                          { Authorization: `Bearer ${acc.api_token}` });
      if (r.ok) working++;
      else broken.push(acc.label || acc.account_id?.slice(0, 6) || "?");
    } catch {
      broken.push(acc.label || "?");
    }
  }

  const total = accounts.length;
  if (working === 0) {
    return { key: "CLOUDFLARE_ACCOUNTS_JSON", status: "bad", working, total,
             detail: `All ${total} Cloudflare accounts failing — AI image generation is down.` };
  }
  if (working < total) {
    return { key: "CLOUDFLARE_ACCOUNTS_JSON", status: "error", working, total,
             detail: `${working}/${total} accounts working. Failing: ${broken.join(", ")}.` };
  }
  return { key: "CLOUDFLARE_ACCOUNTS_JSON", status: "ok", working, total,
           detail: `All ${total} accounts verified.` };
}

/** One probe per provider. Each endpoint is read-only and free. */
async function probeOne(key: string, value: string): Promise<KeyHealth> {
  if (!value) return { key, status: "unset", detail: "Not set." };

  switch (key) {
    case "NVIDIA_NIM_API_KEY":
      return { key, ...(await probeBearer("https://integrate.api.nvidia.com/v1/models", value)) };
    case "GROQ_API_KEY":
      return { key, ...(await probeBearer("https://api.groq.com/openai/v1/models", value)) };
    case "OPENROUTER_API_KEY":
      return { key, ...(await probeBearer("https://openrouter.ai/api/v1/key", value)) };
    case "HF_TOKEN":
      return { key, ...(await probeBearer("https://huggingface.co/api/whoami-v2", value)) };

    case "CLOUDFLARE_ACCOUNTS_JSON":
      return probeCloudflarePool(value);

    case "STABLEHORDE_API_KEY":
      try {
        const r = await get("https://stablehorde.net/api/v2/find_user", { apikey: value });
        return { key, ...classify(r.status) };
      } catch (e) {
        return { key, status: "error", detail: `Unreachable (${String(e).slice(0, 50)}).` };
      }

    case "PEXELS_API_KEY":
      try {
        const r = await get("https://api.pexels.com/v1/curated?per_page=1", { Authorization: value });
        return { key, ...classify(r.status) };
      } catch (e) {
        return { key, status: "error", detail: `Unreachable (${String(e).slice(0, 50)}).` };
      }

    case "PIXABAY_API_KEY":
      try {
        const r = await get(
          `https://pixabay.com/api/?key=${encodeURIComponent(value)}&q=test&per_page=3`, {});
        return { key, ...classify(r.status) };
      } catch (e) {
        return { key, status: "error", detail: `Unreachable (${String(e).slice(0, 50)}).` };
      }

    default:
      // Storage credentials and anything else we can't probe cheaply
      // are reported as present rather than pretending to verify them.
      return { key, status: "ok", detail: "Set (not independently verifiable)." };
  }
}

const POOL_DOC_ID = "platform_pool__api_keys";

async function readPool(): Promise<Record<string, string>> {
  const snap = await adminDb().collection("settings").doc(POOL_DOC_ID).get();
  if (!snap.exists) return {};
  const raw = (snap.data() as { data?: unknown } | undefined)?.data;
  const parsed =
    typeof raw === "string" ? JSON.parse(raw) :
    raw && typeof raw === "object" ? raw : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

/** Probe every pooled credential and persist the summary. */
export async function checkPool(persist = true): Promise<{
  items: KeyHealth[]; broken: number; checked_at: number;
}> {
  const pool = await readPool();
  const items: KeyHealth[] = [];
  for (const [k, v] of Object.entries(pool)) {
    items.push(await probeOne(k, v));
  }
  const checked_at = Math.floor(Date.now() / 1000);
  const broken = items.filter((i) => i.status === "bad").length;

  if (persist) {
    try {
      await adminDb().collection("settings").doc(HEALTH_DOC_ID).set({
        // Values are never stored here — only key names and status.
        data: { items, broken, checked_at },
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: false });
    } catch {
      // Health tracking must never break the caller.
    }
  }
  return { items, broken, checked_at };
}

/** Last stored result, without hitting any provider. */
export async function readPoolHealth(): Promise<{
  items: KeyHealth[]; broken: number; checked_at: number;
}> {
  try {
    const snap = await adminDb().collection("settings").doc(HEALTH_DOC_ID).get();
    if (!snap.exists) return { items: [], broken: 0, checked_at: 0 };
    const raw = (snap.data() as { data?: unknown } | undefined)?.data;
    const d = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      items?: KeyHealth[]; broken?: number; checked_at?: number;
    };
    return {
      items: d?.items || [],
      broken: Number(d?.broken || 0),
      checked_at: Number(d?.checked_at || 0),
    };
  } catch {
    return { items: [], broken: 0, checked_at: 0 };
  }
}
