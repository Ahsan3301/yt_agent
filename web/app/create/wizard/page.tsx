"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  Wand2, ArrowLeft, ArrowRight, Sparkles, FileText, Image as ImageIcon,
  Settings as SettingsIcon, Send, Loader2, Plus, X, CheckCircle2,
  Layers, Mic, Globe,
} from "lucide-react";
import {
  PRESET_CHANNELS, loadCustomChannels, type ChannelPreset,
} from "@/lib/channels";
import { useToast } from "@/components/Toast";

/**
 * Step-based video creation wizard. The dashboard's quick-run + the
 * /create panel are still there — this is the FULL-control path with
 * preview at each stage.
 *
 * Five steps:
 *   1. Channel — pick which YouTube channel + which niche.
 *   2. Content — topic seed OR full script + title override.
 *   3. Visuals — upload images, configure web research, AI image style.
 *   4. Voice + delivery — voice override, dry-run, web-research override.
 *   5. Review + queue — final summary, submit, link to /queue/[id].
 *
 * State is held in component memory only. No Firestore draft. If the
 * user wants to keep things, they submit at the end.
 */

type Channel = {
  id: string;
  name: string;
  niche: string;
  daily_count: number;
  enabled: boolean;
  description?: string;
  web_research?: boolean | null;
};

type WizardState = {
  // Step 1
  channelId: string;        // FROM /api/channels (the destination)
  niche: string;            // FROM PRESET_CHANNELS or custom
  customNicheDesc: string;
  // Step 2
  mode: "topic" | "script";
  topic: string;
  script: string;
  title: string;
  // Step 3
  images: { url: string; size: number; preview: string }[];
  webResearch: "default" | "on" | "off";
  // Step 4
  dryRun: boolean;
};

const STEPS = [
  { key: "channel", label: "Channel",   icon: Layers   },
  { key: "content", label: "Content",   icon: FileText },
  { key: "visuals", label: "Visuals",   icon: ImageIcon },
  { key: "voice",   label: "Delivery",  icon: Mic      },
  { key: "review",  label: "Review",    icon: CheckCircle2 },
] as const;

export default function WizardPage() {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>({
    channelId: "",
    niche: "horror",
    customNicheDesc: "",
    mode: "topic",
    topic: "",
    script: "",
    title: "",
    images: [],
    webResearch: "default",
    dryRun: true,
  });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [customs, setCustoms] = useState<ChannelPreset[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Load channels list (Firestore) + localStorage custom niches.
  useEffect(() => {
    fetch("/api/channels", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setChannels(d))
      .catch(() => { /* ignore */ });
    setCustoms(loadCustomChannels());
  }, []);

  // Auto-fill niche when user picks a channel from the dropdown.
  useEffect(() => {
    if (!state.channelId) return;
    const ch = channels.find((c) => c.id === state.channelId);
    if (ch && ch.niche !== state.niche) {
      setState((s) => ({ ...s, niche: ch.niche }));
    }
  }, [state.channelId, channels]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step 1: Channel + niche ──────────────────────────────
  const StepChannel = () => (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Layers className="h-4 w-4 text-accent" /> Pick your channel
      </h2>

      {channels.length > 0 && (
        <div>
          <label className="label">Existing channel</label>
          <select
            className="select"
            value={state.channelId}
            onChange={(e) => setState({ ...state, channelId: e.target.value })}
          >
            <option value="">— pick one of your channels —</option>
            {channels.filter((c) => c.enabled).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.niche} · {c.daily_count}/day
              </option>
            ))}
          </select>
          <div className="text-[11px] text-neutral-500 mt-1">
            Or skip this and just pick a niche below.
            <Link href="/channels" className="text-accent hover:underline ml-2">Manage channels →</Link>
          </div>
        </div>
      )}

      <div>
        <label className="label">Niche (content style)</label>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {PRESET_CHANNELS.map((p) => (
            <button
              key={p.name}
              onClick={() => setState({ ...state, niche: p.name })}
              className={clsx(
                "px-2.5 h-9 rounded-md border text-xs text-left transition",
                state.niche === p.name
                  ? "border-accent/50 bg-accent/10 text-white"
                  : "border-line text-neutral-300 hover:border-neutral-500",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {customs.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
              Your custom niches
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {customs.map((p) => (
                <button
                  key={p.name}
                  onClick={() => setState({ ...state, niche: p.name })}
                  className={clsx(
                    "px-2.5 h-9 rounded-md border border-dashed text-xs text-left transition truncate",
                    state.niche === p.name
                      ? "border-accent/50 bg-accent/10 text-white"
                      : "border-line text-neutral-300 hover:border-neutral-500",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // ── Step 2: Content (topic vs script) ───────────────────
  const StepContent = () => (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <FileText className="h-4 w-4 text-accent" /> Tell the AI what to write
      </h2>

      <div className="flex items-center gap-1">
        <button
          onClick={() => setState({ ...state, mode: "topic" })}
          className={clsx(
            "px-3 h-8 rounded-md border text-sm",
            state.mode === "topic"
              ? "border-accent/50 bg-accent/10 text-white"
              : "border-line text-neutral-400 hover:text-neutral-200",
          )}
        >
          <Sparkles className="h-3.5 w-3.5 inline mr-1" /> Topic seed
        </button>
        <button
          onClick={() => setState({ ...state, mode: "script" })}
          className={clsx(
            "px-3 h-8 rounded-md border text-sm",
            state.mode === "script"
              ? "border-accent/50 bg-accent/10 text-white"
              : "border-line text-neutral-400 hover:text-neutral-200",
          )}
        >
          <FileText className="h-3.5 w-3.5 inline mr-1" /> Full script
        </button>
      </div>

      {state.mode === "topic" ? (
        <div>
          <label className="label">
            Topic — short phrase, the LLM writes the script
          </label>
          <textarea
            className="input w-full"
            rows={3}
            value={state.topic}
            onChange={(e) => setState({ ...state, topic: e.target.value })}
            placeholder="e.g. 'a Welsh village where the chapel bell rang once in 1973'"
            maxLength={1000}
            autoFocus
          />
          <div className="text-[10px] text-neutral-500 text-right">{state.topic.length}/1000</div>
        </div>
      ) : (
        <div>
          <label className="label">
            Full script — pasted narration; LLM polishes + adds hook
          </label>
          <textarea
            className="input w-full font-mono text-xs"
            rows={10}
            value={state.script}
            onChange={(e) => setState({ ...state, script: e.target.value })}
            placeholder="Paste the full narration here."
            maxLength={20_000}
          />
          <div className="text-[10px] text-neutral-500 text-right">
            {state.script.length}/20,000 · ~{state.script.split(/\s+/).filter(Boolean).length} words
          </div>
        </div>
      )}

      <div>
        <label className="label">YouTube title (optional)</label>
        <input
          className="input w-full"
          value={state.title}
          onChange={(e) => setState({ ...state, title: e.target.value })}
          placeholder="Leave blank to auto-generate"
          maxLength={100}
        />
      </div>
    </div>
  );

  // ── Step 3: Visuals ─────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        toast.warn("Skipped", `${file.name}: not an image`);
        continue;
      }
      if (file.size > 4 * 1024 * 1024) {
        toast.warn("Skipped", `${file.name}: must be < 4 MB`);
        continue;
      }
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch("/api/upload-image", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) {
          toast.error("Upload failed", d.error || r.statusText);
          continue;
        }
        setState((s) => ({
          ...s,
          images: [...s.images, {
            url: d.url, size: d.size, preview: URL.createObjectURL(file),
          }],
        }));
      } catch (e) {
        toast.error("Upload failed", String(e));
      }
    }
    setUploading(false);
  };

  const StepVisuals = () => (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-accent" /> Visuals
      </h2>

      <div className="card space-y-3">
        <div className="text-sm font-medium">Uploaded images (optional)</div>
        <div className="text-xs text-neutral-500">
          Used as shot footage in upload order. Missing slots are filled from
          stock providers + AI generation (HF SDXL → Pollinations).
        </div>
        {state.images.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {state.images.map((img, i) => (
              <div key={i} className="relative aspect-square rounded-md overflow-hidden border border-line bg-bg-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.preview} alt="" className="absolute inset-0 w-full h-full object-cover" />
                <button
                  onClick={() => setState((s) => ({
                    ...s, images: s.images.filter((_, j) => j !== i),
                  }))}
                  className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/70 hover:bg-red-500/70 flex items-center justify-center text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="btn btn-ghost h-8 text-xs"
          >
            {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add images
          </button>
          <span className="text-[10px] text-neutral-500">JPG/PNG/WebP, &lt;4 MB</span>
        </div>
      </div>

      <div className="card space-y-2">
        <div className="text-sm font-medium flex items-center gap-2">
          <Globe className="h-4 w-4 text-accent" /> Web research
        </div>
        <div className="text-xs text-neutral-500">
          When ON, NIM controls a headless Chromium to fact-check + grab hero
          images. Adds ~30-60 sec per render. Default depends on niche.
        </div>
        <div className="flex gap-1">
          {(["default", "on", "off"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setState({ ...state, webResearch: v })}
              className={clsx(
                "px-2.5 h-7 rounded-md border text-xs",
                state.webResearch === v
                  ? "border-accent/50 bg-accent/10 text-white"
                  : "border-line text-neutral-400 hover:text-neutral-200",
              )}
            >
              {v === "default" ? "Niche default" : v.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // ── Step 4: Delivery ────────────────────────────────────
  const StepDelivery = () => (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Mic className="h-4 w-4 text-accent" /> Delivery
      </h2>
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox" className="accent-accent mt-1"
          checked={state.dryRun}
          onChange={(e) => setState({ ...state, dryRun: e.target.checked })}
        />
        <div>
          <div>Dry-run mode</div>
          <div className="text-xs text-neutral-500">
            Render + save to R2 but DON&apos;T publish to YouTube. Recommended
            for the first render on a new channel — preview before going live.
          </div>
        </div>
      </label>

      <div className="card text-xs text-neutral-400 space-y-1">
        <div className="font-medium text-neutral-300 mb-1">Voice + music</div>
        <p>
          Voice + music settings come from the niche preset. To override per-niche,
          edit on the <Link href="/settings" className="text-accent hover:underline">Settings → Voice</Link> tab.
          Per-job voice override is on the roadmap.
        </p>
      </div>
    </div>
  );

  // ── Step 5: Review ──────────────────────────────────────
  const submit = async () => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        channel: state.niche,
        dry_run: state.dryRun,
      };
      if (state.mode === "topic" && state.topic.trim()) {
        body.manual_topic = state.topic.trim();
      }
      if (state.mode === "script" && state.script.trim()) {
        body.manual_script = state.script.trim();
      }
      if (state.title.trim()) body.manual_title = state.title.trim();
      if (state.images.length > 0) {
        body.manual_images = state.images.map((i) => i.url);
      }
      if (state.webResearch === "on") body.web_research = true;
      if (state.webResearch === "off") body.web_research = false;

      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error("Queue failed", d.error || `HTTP ${r.status}`);
      } else if (d.id) {
        toast.success("Queued", `Job ${d.id.slice(0, 8)} is on its way.`);
        window.location.href = `/queue/${d.id}`;
      }
    } catch (e) {
      toast.error("Queue failed", String(e));
    }
    setSubmitting(false);
  };

  const selectedChannel = channels.find((c) => c.id === state.channelId);
  const StepReview = () => (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-accent" /> Review + queue
      </h2>
      <div className="card text-sm space-y-1.5">
        <Row k="Channel"  v={selectedChannel?.name || "(none — niche-only)"} />
        <Row k="Niche"    v={state.niche} />
        <Row k="Mode"     v={state.mode === "topic" ? "Topic seed (AI writes script)" : "Full script (AI polishes)"} />
        {state.mode === "topic" && (
          <Row k="Topic"  v={state.topic.slice(0, 80) + (state.topic.length > 80 ? "…" : "") || "(empty)"} />
        )}
        {state.mode === "script" && (
          <Row k="Words"  v={`${state.script.split(/\s+/).filter(Boolean).length} words`} />
        )}
        {state.title && <Row k="Title override" v={state.title} />}
        <Row k="Images"   v={`${state.images.length} uploaded`} />
        <Row k="Web research" v={state.webResearch === "default" ? "(niche default)" : state.webResearch.toUpperCase()} />
        <Row k="Dry-run"  v={state.dryRun ? "yes — skip YouTube upload" : "no — publish to YouTube"} />
      </div>
      <div className="text-xs text-neutral-500">
        Queueing creates a job in Firestore. The next available GPU worker
        claims it. You&apos;ll be redirected to the job detail page to watch
        progress.
      </div>
    </div>
  );

  // ── Step gate logic ─────────────────────────────────────
  const canAdvance = (i: number): boolean => {
    if (i === 0) return !!state.niche;
    if (i === 1) {
      return state.mode === "topic"
        ? state.topic.trim().length > 5
        : state.script.trim().length > 50;
    }
    return true;
  };

  const renderStep = () => {
    switch (STEPS[step].key) {
      case "channel": return <StepChannel />;
      case "content": return <StepContent />;
      case "visuals": return <StepVisuals />;
      case "voice":   return <StepDelivery />;
      case "review":  return <StepReview />;
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/create" className="text-xs text-neutral-400 hover:text-accent inline-flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> Back to quick create
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2 mt-2">
          <Wand2 className="h-6 w-6 text-accent" />
          Video wizard
        </h1>
        <p className="text-sm text-neutral-400 max-w-2xl mt-1">
          Step through every option with control at each stage. For a one-click
          submit, use <Link href="/create" className="text-accent hover:underline">Quick create</Link> instead.
        </p>
      </div>

      {/* Step tracker */}
      <div className="flex items-center gap-2 flex-wrap">
        {STEPS.map((s, i) => {
          const done = i < step;
          const current = i === step;
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              onClick={() => setStep(i)}
              className={clsx(
                "flex items-center gap-1.5 px-2.5 h-8 rounded-md border text-xs",
                done    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" :
                current ? "border-accent/50 bg-accent/10 text-white" :
                          "border-line text-neutral-500 hover:text-neutral-200",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{s.label}</span>
              <span className="sm:hidden">{i + 1}</span>
            </button>
          );
        })}
      </div>

      {/* Current step */}
      <div className="card">
        {renderStep()}
      </div>

      {/* Nav */}
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setStep((i) => Math.max(0, i - 1))}
          disabled={step === 0}
          className="btn btn-ghost"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            onClick={() => setStep((i) => Math.min(STEPS.length - 1, i + 1))}
            disabled={!canAdvance(step)}
            className="btn btn-primary"
          >
            Next <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={submitting}
            className="btn btn-primary"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Queue render
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 w-28 shrink-0">{k}</div>
      <div className="text-sm text-neutral-200 flex-1 break-words">{v}</div>
    </div>
  );
}
