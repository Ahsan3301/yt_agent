"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Save, ExternalLink, Loader2, CheckCircle2, AlertCircle, Copy,
  Brain, Image as ImageIcon, Bell, PlaySquare, Database, Cloud,
  GitBranch, BookOpen, KeyRound, Sparkles, Server,
} from "lucide-react";
import clsx from "clsx";
import { getKeys, putKeys, type KeyStatus } from "@/lib/api";

// ── Catalog of dashboard-managed keys (stored in Firestore) ────────
//
// Each entry has:
//   name        — the env var name backends look for
//   label       — human readable
//   description — what it's used for, free-tier specs
//   get_url     — DEEP LINK to the page where you create/copy the key
//   docs_url    — link to that provider's documentation
//   importance  — critical | recommended | optional
//   generate    — boolean; if true, show a "Generate random" button
//   managed_via — if set, the value is set automatically by another flow;
//                 disable manual edit and point users at the right tab

type ImportanceKey = "critical" | "recommended" | "optional";

type ManagedKey = {
  name: string;
  label: string;
  description: string;
  get_url?: string;
  docs_url?: string;
  importance: ImportanceKey;
  generate?: boolean;
  managed_via?: string;
};

const SECTIONS: Array<{
  section: string;
  icon: typeof Brain;
  blurb: string;
  keys: ManagedKey[];
}> = [
  {
    section: "AI & Language",
    icon: Brain,
    blurb:
      "LLMs for scripts + storyboards + vision-judging shot fits, and AI image generation for shots not covered by stock providers.",
    keys: [
      {
        name: "NVIDIA_NIM_API_KEY",
        label: "NVIDIA NIM",
        description:
          "Primary LLM (Nemotron-3-Super-120B) and vision judge. Free tier: 40 req/min. Apply for the free dev tier and you get an API key instantly.",
        get_url: "https://build.nvidia.com/explore/discover",
        docs_url: "https://docs.api.nvidia.com/",
        importance: "recommended",
      },
      {
        name: "GROQ_API_KEY",
        label: "Groq (LLM fallback)",
        description:
          "Used when NIM rate-limits. Free tier: 30 req/min on Llama 3 models.",
        get_url: "https://console.groq.com/keys",
        docs_url: "https://console.groq.com/docs/quickstart",
        importance: "optional",
      },
      {
        name: "HF_TOKEN",
        label: "Hugging Face Inference (SDXL fallback)",
        description:
          "Second AI image fallback when Pollinations rate-limits. Free with HF account. Generate a Read-scope token at the link below.",
        get_url: "https://huggingface.co/settings/tokens",
        docs_url: "https://huggingface.co/docs/api-inference/index",
        importance: "recommended",
      },
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        label: "Cloudflare Account ID (Flux 2 dev)",
        description:
          "Tier-1 image provider: FLUX.2 [dev] via Workers AI free tier (~150 images/day free at ~56 neurons/image against a 10,000 neurons/day quota). Account ID is the 32-char hex on the right sidebar of any Cloudflare dashboard page.",
        get_url: "https://dash.cloudflare.com/",
        docs_url: "https://developers.cloudflare.com/workers-ai/",
        importance: "recommended",
      },
      {
        name: "CLOUDFLARE_API_TOKEN",
        label: "Cloudflare API Token (Workers AI Read)",
        description:
          "Create at My Profile → API Tokens → Create Custom Token. Only permission needed: Account → Workers AI → Read. Scope to your account.",
        get_url: "https://dash.cloudflare.com/profile/api-tokens",
        docs_url: "https://developers.cloudflare.com/workers-ai/get-started/rest-api/",
        importance: "recommended",
      },
      {
        name: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key (LLM 2nd-layer)",
        description:
          "Free-tier llama-3.3 70B via OpenRouter. Used as a second-layer LLM fallback when NIM times out and Groq is rate-limited. Sign up + create an API key at openrouter.ai/keys.",
        get_url: "https://openrouter.ai/keys",
        docs_url: "https://openrouter.ai/docs",
        importance: "recommended",
      },
      {
        name: "OPENROUTER_MODEL",
        label: "OpenRouter Model (optional override)",
        description:
          "Defaults to meta-llama/llama-3.3-70b-instruct:free. Only set this if you want to point OpenRouter at a specific paid model.",
        get_url: "https://openrouter.ai/models",
        docs_url: "https://openrouter.ai/docs",
        importance: "optional",
      },
    ],
  },
  {
    section: "Stock Footage",
    icon: ImageIcon,
    blurb:
      "Sources for video clips + images that match the storyboard's per-shot search queries. At least one is highly recommended — without any, the pipeline falls back to AI image generation only.",
    keys: [
      {
        name: "PEXELS_API_KEY",
        label: "Pexels",
        description: "Free stock videos + photos. 200 req/hour. Excellent for atmospheric horror.",
        get_url: "https://www.pexels.com/api/new/",
        docs_url: "https://www.pexels.com/api/documentation/",
        importance: "recommended",
      },
      {
        name: "PIXABAY_API_KEY",
        label: "Pixabay",
        description: "Free stock videos + photos + music. 100 req/min.",
        get_url: "https://pixabay.com/api/docs/",
        docs_url: "https://pixabay.com/api/docs/",
        importance: "optional",
      },
      {
        name: "SHUTTERSTOCK_API_TOKEN",
        label: "Shutterstock (user token)",
        description: "Premium licensed previews. 500/month free trial. Generated from your app's Authentication tab.",
        get_url: "https://www.shutterstock.com/account/developers/apps",
        docs_url: "https://api-reference.shutterstock.com/",
        importance: "optional",
      },
      {
        name: "SHUTTERSTOCK_CLIENT_ID",
        label: "Shutterstock Consumer Key",
        description: "Required only if you don't have a long-lived user token.",
        get_url: "https://www.shutterstock.com/account/developers/apps",
        docs_url: "https://api-reference.shutterstock.com/",
        importance: "optional",
      },
      {
        name: "SHUTTERSTOCK_CLIENT_SECRET",
        label: "Shutterstock Consumer Secret",
        description: "Paired with the Consumer Key. Treat as a password.",
        get_url: "https://www.shutterstock.com/account/developers/apps",
        docs_url: "https://api-reference.shutterstock.com/",
        importance: "optional",
      },
      {
        name: "COVERR_API_KEY",
        label: "Coverr",
        description: "Curated cinematic clips (key required for download API).",
        get_url: "https://coverr.co/developers",
        docs_url: "https://coverr.co/developers",
        importance: "optional",
      },
    ],
  },
  {
    section: "Alerts & Automation",
    icon: Bell,
    blurb:
      "Webhook for Discord notifications + shared secret that authenticates GitHub Actions cron triggers to the dashboard gateway.",
    keys: [
      {
        name: "DISCORD_WEBHOOK_URL",
        label: "Discord webhook",
        description:
          "Channel that gets notified on pipeline complete/fail/YouTube publish/cleanup. In Discord: Server settings → Integrations → Webhooks → New Webhook → copy URL.",
        get_url: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
        docs_url: "https://discord.com/developers/docs/resources/webhook",
        importance: "recommended",
      },
      {
        name: "RENDER_TRIGGER_KEY",
        label: "GitHub Actions shared secret",
        description:
          "Random string. The SAME value must be set as a GitHub repo secret (or matches the Coolify env var) so the cron job can call your dashboard maintenance routes. Click Generate to get a fresh value.",
        generate: true,
        importance: "recommended",
      },
    ],
  },
  {
    section: "Storage (R2 + SFTP)",
    icon: Database,
    blurb:
      "Credentials for video storage. Moved into Firestore so Kaggle (which loses its Add-ons → Secrets attachments on every new notebook version) only needs ONE platform-level secret (the Firebase service account). Colab + HF Space pick these up the same way.",
    keys: [
      {
        name: "R2_ACCOUNT_ID",
        label: "Cloudflare R2 Account ID",
        description: "Find it at https://dash.cloudflare.com/?to=/:account/r2/overview — top-right of the R2 page.",
        get_url: "https://dash.cloudflare.com/?to=/:account/r2/overview",
        docs_url: "https://developers.cloudflare.com/r2/api/s3/tokens/",
        importance: "recommended",
      },
      {
        name: "R2_ACCESS_KEY_ID",
        label: "R2 Access Key ID",
        description: "From R2 → Manage R2 API Tokens → Create API token (Read & Write).",
        get_url: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens",
        importance: "recommended",
      },
      {
        name: "R2_SECRET_ACCESS_KEY",
        label: "R2 Secret Access Key",
        description: "Paired with the access key ID. Treat as a password.",
        get_url: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens",
        importance: "recommended",
      },
      {
        name: "R2_BUCKET",
        label: "R2 Bucket Name",
        description: "The bucket where videos land (e.g. yt-agent-videos).",
        importance: "recommended",
      },
      {
        name: "R2_PUBLIC_URL",
        label: "R2 Public URL",
        description: "The pub-xxxxx.r2.dev URL Cloudflare assigns when you enable public access on the bucket.",
        importance: "recommended",
      },
      {
        name: "SFTP_HOST",
        label: "Hostinger SFTP Host",
        description: "Optional. Used as R2 overflow archive when R2 hits R2_MAX_GB.",
        get_url: "https://hpanel.hostinger.com/files-and-folders/file-manager/ssh",
        importance: "optional",
      },
      {
        name: "SFTP_USER",
        label: "Hostinger SFTP User",
        description: "Optional.",
        importance: "optional",
      },
      {
        name: "SFTP_PASS",
        label: "Hostinger SFTP Password",
        description: "Optional. Treat as a password.",
        importance: "optional",
      },
      {
        name: "SFTP_PORT",
        label: "Hostinger SFTP Port",
        description: "Optional. Default 65002 on Hostinger.",
        importance: "optional",
      },
      {
        name: "SFTP_BASE_DIR",
        label: "Hostinger SFTP Base Directory",
        description: "Optional. e.g. domains/yourdomain.com/public_html/videos.",
        importance: "optional",
      },
      {
        name: "PUBLIC_BASE_URL",
        label: "Hostinger Public Base URL",
        description: "Optional. e.g. https://yourdomain.com — the URL prefix the SFTP files are served from.",
        importance: "optional",
      },
    ],
  },
  {
    section: "Auto-Publish",
    icon: PlaySquare,
    blurb:
      "YouTube credentials. The refresh token is set automatically by the 'Connect YouTube' button on the Automation tab — don't paste it manually here.",
    keys: [
      {
        name: "YOUTUBE_REFRESH_TOKEN",
        label: "YouTube OAuth refresh token",
        description:
          "Created by the OAuth consent flow. Don't edit manually — use the 'Connect YouTube' button on the Automation tab.",
        managed_via: "/settings",
        importance: "optional",
      },
    ],
  },
];

// ── Platform-level secrets (NOT managed from dashboard) ─────────
// These are bootstrap secrets that workers / dashboard / GitHub Actions
// read at startup, so they live on each platform's secret store and
// can't be loaded from Firestore (chicken-and-egg).

type PlatformSecret = {
  section: string;
  description: string;
  badge: "Dashboard" | "Colab/HF" | "GitHub";
  get_url?: string;
  docs_url?: string;
  vars: string[];
};

const PLATFORM_SECRETS: PlatformSecret[] = [
  {
    section: "Firebase / Firestore credentials",
    description:
      "(Legacy Firebase deployments only.) Required to write to Firestore from each platform. Same JSON service-account file goes on the dashboard + Colab + HF Space, in different env var names per environment. Coolify/Pocketbase deployments skip this entirely.",
    badge: "Dashboard",
    get_url: "https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk",
    docs_url: "https://firebase.google.com/docs/admin/setup",
    vars: [
      "FIREBASE_SERVICE_ACCOUNT_JSON  (server-side; dashboard env vars)",
      "NEXT_PUBLIC_FIREBASE_CONFIG    (client-side; dashboard env vars)",
    ],
  },
  {
    section: "Firebase / Firestore credentials (workers)",
    description:
      "Same service-account JSON, pasted into the Colab Secrets panel and the HF Space Variables and secrets list.",
    badge: "Colab/HF",
    get_url: "https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk",
    docs_url: "https://firebase.google.com/docs/admin/setup",
    vars: ["GOOGLE_APPLICATION_CREDENTIALS_JSON"],
  },
  // R2 + SFTP moved out of Platform-level Secrets — they're now Firestore-
  // managed in the 'Storage' section above. The only platform-level secret
  // workers still need is GOOGLE_APPLICATION_CREDENTIALS_JSON (Firebase).
  {
    section: "YouTube OAuth Client (for auto-publish flow)",
    description:
      "Used by /api/youtube/auth + /callback to run the consent screen. Only needed if you want auto-publish. The Web Application redirect URI MUST exactly match  https://<your-vercel-url>/api/youtube/callback.",
    badge: "Dashboard",
    get_url: "https://console.cloud.google.com/apis/credentials",
    docs_url:
      "https://developers.google.com/youtube/v3/guides/auth/installed-apps",
    vars: [
      "YOUTUBE_OAUTH_CLIENT_ID",
      "YOUTUBE_OAUTH_CLIENT_SECRET",
    ],
  },
  {
    section: "GitHub Actions secrets",
    description:
      "For automatic HF Space sync + daily render cron + cleanup. Set as repository secrets.",
    badge: "GitHub",
    get_url:
      "https://github.com/Ahsan3301/yt_agent/settings/secrets/actions",
    docs_url:
      "https://docs.github.com/en/actions/security-guides/encrypted-secrets",
    vars: [
      "HF_TOKEN              (Write-scope HuggingFace token; lets the sync workflow push to your Space)",
      "RENDER_TRIGGER_KEY    (same value as the Firestore key, above)",
      "DASHBOARD_BASE_URL    (optional repo variable; defaults to whatever your deployment's public URL is)",
    ],
  },
  {
    section: "Kaggle on-demand GPU worker",
    description:
      "Free T4 / P100 fallback when Colab is offline. The kaggle-dispatch.yml workflow wakes a Kaggle notebook whenever the queue has work and no GPU is alive. Notebook self-terminates after 10 min idle so it doesn't burn the 30 GPU hr/week budget. See kaggle/README.md for the full setup.",
    badge: "GitHub",
    get_url: "https://www.kaggle.com/settings/account",
    docs_url:
      "https://github.com/Ahsan3301/yt_agent/blob/main/kaggle/README.md",
    vars: [
      "KAGGLE_USERNAME       (from kaggle.json — Account → Create New Token)",
      "KAGGLE_KEY            (from kaggle.json — same place)",
      "HF_SPACE_URL          (optional repo variable; defaults to your space)",
    ],
  },
];

const ALL_MANAGED_KEYS = SECTIONS.flatMap((s) => s.keys.map((k) => k.name));

export default function KeysPage() {
  const [keys, setKeys] = useState<Record<string, KeyStatus>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refresh = () => getKeys().then(setKeys).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    const updates: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(edits)) {
      updates[k] = v === "" ? null : v;
    }
    if (Object.keys(updates).length === 0) return;
    setSaving(true);
    try {
      await putKeys(updates);
      setEdits({});
      setSavedAt(Date.now());
      await refresh();
    } catch (e) {
      alert("Save failed: " + (e as Error).message);
    }
    setSaving(false);
  };

  // ── Coverage gauge ──
  const { recommendedSet, recommendedTotal } = useMemo(() => {
    const want = SECTIONS.flatMap((s) =>
      s.keys
        .filter((k) => k.importance !== "optional" && !k.managed_via)
        .map((k) => k.name),
    );
    return {
      recommendedTotal: want.length,
      recommendedSet: want.filter((n) => keys[n]?.set).length,
    };
  }, [keys]);

  return (
    <div className="space-y-6">
      {/* ── Header + coverage gauge ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="text-sm text-neutral-400 max-w-2xl">
            All your keys, grouped by what they do, with deep-links to where you
            create them. Values are stored in Firestore so every backend picks
            them up automatically. Platform-level bootstrap secrets are listed
            at the bottom — those have to go on their respective platforms.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={saving || Object.keys(edits).length === 0}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save{Object.keys(edits).length ? ` (${Object.keys(edits).length})` : ""}
        </button>
      </div>

      {savedAt && Date.now() - savedAt < 4000 && (
        <div className="card border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-200">
          Saved.
        </div>
      )}

      {/* ── 1-click OAuth providers ── */}
      <OneClickAuth keys={keys} onRefresh={refresh} />

      {/* Coverage bar */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <span className="font-medium">Recommended coverage</span>
          </div>
          <span className="font-mono text-neutral-300">
            {recommendedSet} / {recommendedTotal} set
          </span>
        </div>
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{
              width: `${Math.max(
                2,
                (recommendedSet / Math.max(1, recommendedTotal)) * 100,
              )}%`,
            }}
          />
        </div>
        <div className="text-xs text-neutral-500">
          Hitting 100% on recommended is enough to render flawlessly. Optional
          keys add resilience.
        </div>
      </div>

      {/* ── Managed keys, by section ── */}
      {SECTIONS.map((section) => (
        <div key={section.section} className="card space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <section.icon className="h-5 w-5 text-accent mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">{section.section}</div>
                <div className="text-xs text-neutral-500">{section.blurb}</div>
              </div>
            </div>
            <span className="pill pill-info text-xs">
              {section.keys.filter((k) => keys[k.name]?.set).length}/
              {section.keys.length}
            </span>
          </div>

          <div className="space-y-2 pt-2 border-t border-line">
            {section.keys.map((k) => (
              <ManagedRow
                key={k.name}
                meta={k}
                status={keys[k.name]}
                editValue={edits[k.name]}
                onEdit={(v) =>
                  setEdits((prev) => {
                    const next = { ...prev };
                    if (v === undefined) delete next[k.name];
                    else next[k.name] = v;
                    return next;
                  })
                }
              />
            ))}
          </div>
        </div>
      ))}

      {/* ── Platform-level secrets ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 pt-4">
          <Server className="h-5 w-5 text-neutral-400" />
          <h2 className="text-lg font-semibold">Platform-level secrets</h2>
        </div>
        <p className="text-sm text-neutral-400 max-w-2xl">
          These can't be set from the dashboard because they're read at
          platform boot (dashboard server init, Colab notebook cell, HF Space
          startup, GitHub Actions runner). Each card tells you what to set and
          where.
        </p>

        {PLATFORM_SECRETS.map((sec) => (
          <PlatformCard key={sec.section} sec={sec} />
        ))}
      </div>
    </div>
  );
}

// ── Row for one Firestore-managed key ────────────────────────────
function ManagedRow({
  meta,
  status,
  editValue,
  onEdit,
}: {
  meta: ManagedKey;
  status?: KeyStatus;
  editValue?: string;
  onEdit: (v: string | undefined) => void;
}) {
  const isSet = !!status?.set;
  const editing = editValue !== undefined;
  const managedElsewhere = !!meta.managed_via;

  return (
    <div className="rounded-md border border-line bg-bg-2 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{meta.label}</span>
            <ImportancePill imp={meta.importance} />
            {managedElsewhere && (
              <span className="pill pill-info text-[10px]">auto-managed</span>
            )}
          </div>
          <code className="text-xs text-neutral-500">{meta.name}</code>
          <div className="text-xs text-neutral-400 mt-1 max-w-xl">
            {meta.description}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isSet ? (
            <span className="pill pill-success">
              <CheckCircle2 className="h-3 w-3" /> set
            </span>
          ) : (
            <span className="pill pill-warn">
              <AlertCircle className="h-3 w-3" /> not set
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {meta.get_url && (
          <a
            href={meta.get_url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost h-7 text-xs"
          >
            <ExternalLink className="h-3 w-3" />
            Get key
          </a>
        )}
        {meta.docs_url && (
          <a
            href={meta.docs_url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost h-7 text-xs"
          >
            <BookOpen className="h-3 w-3" />
            Docs
          </a>
        )}
        {meta.managed_via && (
          <a
            href={meta.managed_via}
            className="btn btn-ghost h-7 text-xs"
          >
            <KeyRound className="h-3 w-3" />
            Configure on Automation tab
          </a>
        )}
        {meta.generate && (
          <button
            type="button"
            onClick={() => {
              // Browser-native random; URL-safe.
              const arr = new Uint8Array(24);
              if (typeof window !== "undefined" && window.crypto) {
                window.crypto.getRandomValues(arr);
              }
              const chars =
                "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
              let out = "";
              for (let i = 0; i < arr.length; i++) {
                out += chars[arr[i] % chars.length];
              }
              onEdit(out);
            }}
            className="btn btn-ghost h-7 text-xs"
          >
            <Sparkles className="h-3 w-3" />
            Generate random
          </button>
        )}
      </div>

      {!managedElsewhere && (
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            className="input flex-1 text-sm"
            placeholder={isSet ? (status?.masked || "masked") : "paste key here"}
            value={editValue ?? ""}
            onChange={(e) => onEdit(e.target.value)}
          />
          {isSet && !editing && (
            <button
              className="btn btn-ghost"
              onClick={() => onEdit("")}
              title="Mark for deletion"
            >
              Clear
            </button>
          )}
          {editing && (
            <button
              className="btn btn-ghost"
              onClick={() => onEdit(undefined)}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Importance pill ──────────────────────────────────────────────
function ImportancePill({ imp }: { imp: ImportanceKey }) {
  const map: Record<ImportanceKey, { text: string; cls: string }> = {
    critical: { text: "required", cls: "border-red-500/30 bg-red-500/10 text-red-300" },
    recommended: { text: "recommended", cls: "border-amber-500/30 bg-amber-500/10 text-amber-300" },
    optional: { text: "optional", cls: "border-neutral-700 bg-bg-2 text-neutral-400" },
  };
  const m = map[imp];
  return (
    <span className={clsx("inline-flex items-center px-1.5 h-5 rounded text-[10px] border", m.cls)}>
      {m.text}
    </span>
  );
}

// ── 1-click OAuth providers panel ────────────────────────────────
function OneClickAuth({
  keys,
  onRefresh,
}: {
  keys: Record<string, KeyStatus>;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const gh = p.get("github");
    const hf = p.get("huggingface");
    if (gh === "connected") {
      const synced = p.get("synced") || "";
      const skipped = p.get("skipped") || "";
      setResult(
        `GitHub connected. Pushed secrets: ${synced || "(none)"}${
          skipped ? ` · Skipped (not in Firestore yet): ${skipped}` : ""
        }`,
      );
      onRefresh();
    } else if (gh && gh !== "connected") {
      setResult(`GitHub connect failed: ${p.get("reason") || gh}`);
    } else if (hf === "connected") {
      setResult("Hugging Face connected. HF_TOKEN set.");
      onRefresh();
    } else if (hf && hf !== "connected") {
      setResult(`Hugging Face connect failed: ${p.get("reason") || hf}`);
    }
    const yt = p.get("youtube");
    if (yt === "connected") {
      const ch = p.get("channel") || "";
      setResult(`YouTube connected${ch ? ` — channel: ${decodeURIComponent(ch)}` : ""}. Publish dropdowns on the Library page will list this account.`);
      onRefresh();
    } else if (yt && yt !== "connected") {
      setResult(`YouTube connect failed: ${p.get("reason") || yt}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (provider: "github" | "huggingface" | "youtube") => {
    setBusy(provider);
    try {
      const r = await fetch(`/api/${provider}/auth`);
      const d = await r.json();
      if (d.url) {
        window.location.href = d.url as string;
      } else {
        setResult(
          `setup-required:${provider}:${d.next_step || d.error || "OAuth client not configured on the dashboard."}`,
        );
        setBusy(null);
      }
    } catch (e) {
      setResult(`${provider} auth failed: ${String(e)}`);
      setBusy(null);
    }
  };

  const reSyncGithub = async () => {
    setBusy("github-sync");
    try {
      const r = await fetch("/api/github/sync", { method: "POST" });
      const d = await r.json();
      if (d.ok) {
        setResult(
          `Re-synced to GitHub. Pushed: ${(d.synced || []).join(", ") || "(none)"}${
            d.skipped?.length ? ` · Skipped: ${d.skipped.join(", ")}` : ""
          }`,
        );
      } else {
        setResult(`Re-sync failed: ${d.error || JSON.stringify(d)}`);
      }
    } catch (e) {
      setResult(`Re-sync failed: ${String(e)}`);
    }
    setBusy(null);
  };

  const githubConnected = !!keys?.GITHUB_ACCESS_TOKEN?.set;
  const hfConnected = !!keys?.HF_TOKEN?.set;
  const [ytAccounts, setYtAccounts] = useState<Array<{ id: string; title: string; youtube_channel_id: string; thumbnail?: string }>>([]);
  useEffect(() => {
    fetch("/api/youtube/accounts").then((r) => r.ok ? r.json() : []).then((d) => setYtAccounts(Array.isArray(d) ? d : [])).catch(() => {});
  }, [keys]);
  const ytConnected = ytAccounts.length > 0;

  const disconnectYt = async (id: string) => {
    if (!confirm("Disconnect this YouTube account? The dashboard will lose upload access.")) return;
    try {
      const r = await fetch(`/api/youtube/disconnect?id=${encodeURIComponent(id)}`, { method: "POST" });
      if (r.ok) {
        setYtAccounts((prev) => prev.filter((a) => a.id !== id));
      } else {
        alert(`Disconnect failed: HTTP ${r.status}`);
      }
    } catch (e) {
      alert(`Disconnect failed: ${String(e)}`);
    }
  };

  return (
    <div className="card border-accent/30 bg-gradient-to-br from-accent/5 to-bg-1 space-y-3">
      <div className="flex items-start gap-3">
        <Sparkles className="h-5 w-5 text-accent mt-0.5" />
        <div>
          <div className="font-semibold">One-click connect</div>
          <div className="text-xs text-neutral-400 max-w-2xl">
            Sign in once and the right keys land in the right places. No copying
            tokens between browser tabs.
          </div>
        </div>
      </div>

      {result && result.startsWith("setup-required:") && (() => {
        const [, provider, nextStep] = result.split(":");
        const consoleUrl = provider === "github"
          ? "https://github.com/settings/applications/new"
          : "https://huggingface.co/settings/applications/new";
        const callbackUrl = typeof window !== "undefined"
          ? `${window.location.origin}/api/${provider}/callback`
          : "";
        return (
          <div className="rounded-md p-3 border border-amber-500/30 bg-amber-500/5 text-amber-100 space-y-2 text-xs">
            <div className="font-medium">One-time setup needed for {provider === "github" ? "GitHub" : "Hugging Face"}</div>
            <ol className="list-decimal list-inside space-y-1 text-amber-200/90">
              <li>
                Create the OAuth app:{" "}
                <a href={consoleUrl} target="_blank" rel="noreferrer" className="underline hover:text-white">
                  {consoleUrl} <ExternalLink className="h-3 w-3 inline" />
                </a>
              </li>
              <li>
                Set the callback / redirect URL to exactly:{" "}
                <code className="bg-bg-2 px-1 rounded">{callbackUrl}</code>
                <button
                  onClick={() => navigator.clipboard?.writeText(callbackUrl)}
                  className="ml-1 opacity-70 hover:opacity-100"
                  title="Copy"
                >
                  <Copy className="h-3 w-3 inline" />
                </button>
              </li>
              <li>
                Copy Client ID + Client Secret → add to your deployment env vars as{" "}
                <code className="bg-bg-2 px-1 rounded">
                  {provider === "github" ? "GITHUB_OAUTH_CLIENT_ID/SECRET" : "HUGGINGFACE_OAUTH_CLIENT_ID/SECRET"}
                </code>
              </li>
              <li>Redeploy the dashboard (Coolify: Redeploy / Vercel: Deployments → ⋯ → Redeploy) → come back here</li>
            </ol>
            <details className="opacity-70">
              <summary className="cursor-pointer">Server message</summary>
              <div className="mt-1 text-[10px] font-mono">{nextStep}</div>
            </details>
          </div>
        );
      })()}

      {result && !result.startsWith("setup-required:") && (
        <div className={clsx(
          "text-xs rounded-md p-2.5 border",
          result.includes("failed") || result.includes("error")
            ? "border-red-500/30 bg-red-500/5 text-red-200"
            : "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
        )}>
          {result}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* GitHub */}
        <div className="rounded-md border border-line bg-bg-2 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-neutral-200" />
              <span className="font-medium text-sm">GitHub</span>
            </div>
            {githubConnected ? (
              <span className="pill pill-success">
                <CheckCircle2 className="h-3 w-3" /> connected
              </span>
            ) : (
              <span className="pill pill-muted text-[10px]">not connected</span>
            )}
          </div>
          <div className="text-xs text-neutral-400">
            Auto-pushes <code>HF_TOKEN</code> + <code>RENDER_TRIGGER_KEY</code>{" "}
            to your repo&apos;s Actions secrets — no manual paste in GitHub
            Settings.
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => start("github")}
              disabled={busy === "github"}
              className="btn btn-primary h-8 text-xs"
            >
              {busy === "github" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <GitBranch className="h-3 w-3" />
              )}
              {githubConnected ? "Re-authenticate" : "Sign in with GitHub"}
            </button>
            {githubConnected && (
              <button
                onClick={reSyncGithub}
                disabled={busy === "github-sync"}
                className="btn btn-ghost h-8 text-xs"
                title="Re-push current Firestore values to GitHub"
              >
                {busy === "github-sync" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Re-sync secrets
              </button>
            )}
          </div>
        </div>

        {/* Hugging Face */}
        <div className="rounded-md border border-line bg-bg-2 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-fuchsia-300" />
              <span className="font-medium text-sm">Hugging Face</span>
            </div>
            {hfConnected ? (
              <span className="pill pill-success">
                <CheckCircle2 className="h-3 w-3" /> connected
              </span>
            ) : (
              <span className="pill pill-muted text-[10px]">not connected</span>
            )}
          </div>
          <div className="text-xs text-neutral-400">
            Skip the &quot;create a new token&quot; tab. OAuth token is stored
            directly as <code>HF_TOKEN</code> and works with the Inference API.
          </div>
          <button
            onClick={() => start("huggingface")}
            disabled={busy === "huggingface"}
            className="btn btn-primary h-8 text-xs"
          >
            {busy === "huggingface" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Brain className="h-3 w-3" />
            )}
            {hfConnected ? "Re-authenticate" : "Sign in with Hugging Face"}
          </button>
        </div>

        {/* YouTube — multi-account. Every sign-in creates a new
            youtube_accounts row; the Publish dropdown on /history
            lists them by channel title. */}
        <div className="rounded-md border border-line bg-bg-2 p-3 space-y-2 sm:col-span-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <PlaySquare className="h-4 w-4 text-red-400" />
              <span className="font-medium text-sm">YouTube</span>
            </div>
            {ytConnected ? (
              <span className="pill pill-success">
                <CheckCircle2 className="h-3 w-3" />
                {ytAccounts.length} channel{ytAccounts.length > 1 ? "s" : ""} connected
              </span>
            ) : (
              <span className="pill pill-muted text-[10px]">not connected</span>
            )}
          </div>
          <div className="text-xs text-neutral-400">
            Upload rendered videos to any YouTube channel from the Library page.
            Sign in multiple times to connect multiple accounts.
          </div>
          {ytAccounts.length > 0 && (
            <div className="space-y-1 pt-1">
              {ytAccounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-xs bg-bg-1 rounded px-2 py-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {a.thumbnail && (
                      <img src={a.thumbnail} alt="" className="h-5 w-5 rounded-full shrink-0" />
                    )}
                    <span className="truncate">{a.title || a.youtube_channel_id}</span>
                  </div>
                  <button
                    onClick={() => disconnectYt(a.id)}
                    className="btn btn-ghost h-6 text-[10px] shrink-0"
                    title="Remove this account. Existing published videos are untouched."
                  >
                    Disconnect
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => start("youtube")}
            disabled={busy === "youtube"}
            className="btn btn-primary h-8 text-xs"
          >
            {busy === "youtube" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <PlaySquare className="h-3 w-3" />
            )}
            {ytConnected ? "Add another channel" : "Sign in with YouTube"}
          </button>
        </div>
      </div>

      <div className="text-[11px] text-neutral-500 pt-2 border-t border-line">
        Other providers (NIM, Groq, Pexels, etc.) don&apos;t support OAuth and
        require manual token paste — they have <code>Get key</code> deep-links
        in their section below.
      </div>
    </div>
  );
}

// ── Platform secret card ─────────────────────────────────────────
function PlatformCard({ sec }: { sec: PlatformSecret }) {
  const badgeMap = {
    Dashboard: { icon: Cloud, cls: "border-sky-500/30 bg-sky-500/10 text-sky-300" },
    "Colab/HF": {
      icon: Server,
      cls: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300",
    },
    GitHub: { icon: GitBranch, cls: "border-neutral-500/30 bg-neutral-500/10 text-neutral-200" },
  } as const;
  const b = badgeMap[sec.badge];

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Database className="h-5 w-5 text-neutral-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{sec.section}</div>
            <div className="text-xs text-neutral-500 mt-0.5 max-w-2xl">
              {sec.description}
            </div>
          </div>
        </div>
        <span
          className={clsx(
            "inline-flex items-center gap-1 px-2 h-6 rounded-md border text-xs",
            b.cls,
          )}
        >
          <b.icon className="h-3 w-3" />
          {sec.badge}
        </span>
      </div>
      <div className="rounded-md border border-line bg-bg-2 p-3 space-y-1 font-mono text-xs">
        {sec.vars.map((v) => (
          <div key={v} className="flex items-center gap-2 text-neutral-300">
            <span className="text-neutral-500">▸</span>
            <code className="break-all">{v}</code>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(v.split(/\s+/)[0])}
              title="Copy name"
              className="ml-auto opacity-0 group-hover:opacity-100 transition"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {sec.get_url && (
          <a
            href={sec.get_url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost h-7 text-xs"
          >
            <ExternalLink className="h-3 w-3" /> Open console
          </a>
        )}
        {sec.docs_url && (
          <a
            href={sec.docs_url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost h-7 text-xs"
          >
            <BookOpen className="h-3 w-3" /> Docs
          </a>
        )}
      </div>
    </div>
  );
}
