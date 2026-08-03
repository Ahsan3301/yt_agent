import { NextRequest, NextResponse } from "next/server";
import { adminDb, FieldValue } from "@/lib/firebase-admin";
import { requireTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Platform key pool — superadmin only.
 *
 * These are the operator's shared credentials, which every tenant
 * inherits. backend/keys_sync.py::_read_all merges this document
 * underneath each tenant's own keys, so a customer who has configured
 * nothing still renders, and a customer who supplies their own
 * overrides the pool per key.
 *
 * This exists because requiring each customer to register with NVIDIA
 * NIM, HuggingFace, Cloudflare, OpenRouter, Stable Horde, Pexels and
 * an S3 provider before their first video made the product unsellable
 * to anyone non-technical.
 *
 * Stored separately from the founder's own blob at settings/api_keys —
 * "the operator's personal credentials" and "credentials customers may
 * use" must be independently controllable.
 */

const POOL_DOC_ID = "platform_pool__api_keys";

/** Keys worth pooling, grouped for the UI. Mirrors the providers the
 *  pipeline actually falls through in backend/jobs.py. */
export const POOL_SCHEMA: Array<{
  key: string; group: string; label: string; help: string;
}> = [
  // Text generation — the pipeline tries these in order.
  { key: "NVIDIA_NIM_API_KEY", group: "Script writing", label: "NVIDIA NIM",
    help: "Primary script + SEO model. Free tier is generous." },
  { key: "GROQ_API_KEY", group: "Script writing", label: "Groq",
    help: "Fast fallback when NIM is rate-limited." },
  { key: "OPENROUTER_API_KEY", group: "Script writing", label: "OpenRouter",
    help: "Last-resort fallback; paid per token." },

  // Imagery — also a fallback chain.
  { key: "CLOUDFLARE_ACCOUNTS_JSON", group: "Visuals", label: "Cloudflare accounts (JSON array)",
    help: 'Rotating pool: [{"label":"a","account_id":"…","api_token":"…"}]. Flux 2 image generation.' },
  { key: "HF_TOKEN", group: "Visuals", label: "HuggingFace token",
    help: "Fallback image generation via Inference API." },
  { key: "STABLEHORDE_API_KEY", group: "Visuals", label: "Stable Horde",
    help: "Free distributed fallback. Slow but costs nothing." },
  { key: "AGNES_API_KEY", group: "Visuals", label: "Agnes AI",
    help: "Multimodal provider (apihub.agnes-ai.com). Powers image generation and short motion clips for opening shots. Video uses the async endpoint (POST /v1/videos, then poll the task id) — not the chat completions route." },
  { key: "PEXELS_API_KEY", group: "Visuals", label: "Pexels",
    help: "Stock footage and photos." },
  { key: "PIXABAY_API_KEY", group: "Visuals", label: "Pixabay",
    help: "Additional stock source." },

  // Search/ranking research.
  { key: "YOUTUBE_API_KEY", group: "SEO research", label: "YouTube Data API key",
    help: "Looks up the videos already ranking for each topic and feeds their keywords to the SEO writer. Without it, metadata is written blind. ~103 quota units per render against a 10,000/day default." },

  // Where rendered videos land.
  { key: "S3_ENDPOINT", group: "Storage", label: "S3 endpoint",
    help: "Leave blank to use the platform's own MinIO." },
  { key: "S3_BUCKET", group: "Storage", label: "S3 bucket", help: "" },
  { key: "S3_ACCESS_KEY_ID", group: "Storage", label: "S3 access key", help: "" },
  { key: "S3_SECRET_ACCESS_KEY", group: "Storage", label: "S3 secret", help: "" },

  // Behaviour flags. Not credentials, but they travel the same path:
  // the pool is how a setting reaches a worker that nobody can SSH into
  // (Kaggle, Colab). A key listed in MANAGED_KEYS but absent here is
  // rejected by PUT, so both lists have to agree.
  { key: "DEFER_PUBLISH_TO_SIDE_WORKER", group: "Pipeline behaviour",
    label: "Defer scheduled publishes to the side-worker",
    help: "1 to enable. A GPU worker that finishes a video with a future publish time hands the upload to the always-on Oracle worker instead of holding the GPU open until the slot arrives. The side-worker never defers to itself. Leave blank to publish from whichever worker rendered." },
  { key: "AGNES_VIDEO_SHOTS", group: "Pipeline behaviour",
    label: "Agnes motion clips per video",
    help: "How many opening shots are generated as short video clips rather than stills. 0 disables. Each clip costs an Agnes video task and adds render time; falls back to a still if generation fails." },
];

const POOLABLE = new Set(POOL_SCHEMA.map((f) => f.key));

function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

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

export async function GET(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const pool = await readPool();
    // Never return the values themselves — only whether each is set
    // and a short preview, same contract as the config endpoint.
    const items = POOL_SCHEMA.map((f) => ({
      ...f,
      has_value: !!pool[f.key],
      // Behaviour flags carry no secret, and masking them would hide
      // the only thing worth reading — whether the flag is on.
      preview: f.group === "Pipeline behaviour"
        ? String(pool[f.key] || "")
        : mask(pool[f.key] || ""),
    }));
    return NextResponse.json({ items, configured: Object.keys(pool).length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireTenant(req);
  if ("response" in auth) return auth.response;
  if (auth.tenant.role !== "superadmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { updates?: Record<string, string> };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const applied: string[] = [];
  const cleared: string[] = [];
  const rejected: string[] = [];

  try {
    const pool = await readPool();
    for (const [rawKey, rawVal] of Object.entries(body.updates || {})) {
      const key = String(rawKey).trim();
      if (!POOLABLE.has(key)) { rejected.push(key); continue; }
      const value = String(rawVal ?? "").trim();
      if (value === "") {
        // Only clear when the caller explicitly sends a sentinel —
        // an empty string from an untouched password field must not
        // silently wipe a working credential.
        continue;
      }
      if (value === "__CLEAR__") {
        delete pool[key];
        cleared.push(key);
        continue;
      }
      pool[key] = value.slice(0, 8000);
      applied.push(key);
    }

    await adminDb().collection("settings").doc(POOL_DOC_ID).set({
      data: pool,
      updated_by: auth.tenant.userId,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: false });

    await audit(auth.tenant, {
      action: "pool.save",
      target_type: "settings",
      target_id: POOL_DOC_ID,
      // Key names only — never values.
      meta: { applied, cleared, rejected },
    }, req);

    return NextResponse.json({ ok: true, applied, cleared, rejected });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
