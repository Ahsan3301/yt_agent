"use client";

import { useState, useRef, useEffect } from "react";
import clsx from "clsx";
import {
  Wand2, FileText, Image as ImageIcon, X, Loader2, Send,
  Sparkles, Plus, AlertCircle, Globe,
} from "lucide-react";

// Built-in channel presets (must mirror modules/channels.py).
// `webDefault` = whether NIM browser research defaults ON for this niche.
// User can flip it per-job via the toggle below.
const PRESET_CHANNELS = [
  { name: "horror",   label: "Horror stories",         webDefault: false },
  { name: "wisdom",   label: "Wisdom + motivation",    webDefault: false },
  { name: "finance",  label: "Finance + business",     webDefault: true  },
  { name: "fitness",  label: "Fitness + discipline",   webDefault: true  },
  { name: "science",  label: "Science + tech",         webDefault: true  },
  { name: "history",  label: "History + mythology",    webDefault: true  },
  { name: "comedy",   label: "Comedy + observational", webDefault: false },
  { name: "food",     label: "Food + cooking",         webDefault: false },
  { name: "travel",   label: "Travel + culture",       webDefault: false },
  { name: "gaming",   label: "Gaming + lore",          webDefault: false },
];

type UploadedImage = {
  url: string;
  size: number;
  preview: string;   // object URL for display
};

export default function CreatePage() {
  const [channel, setChannel] = useState("horror");
  const [customChannel, setCustomChannel] = useState("");
  const [customDesc, setCustomDesc] = useState("");
  const [useCustom, setUseCustom] = useState(false);

  const [mode, setMode] = useState<"topic" | "script">("topic");
  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [title, setTitle] = useState("");
  const [dryRun, setDryRun] = useState(true);
  // Web research override. `null` = use channel default. Switching
  // channels resets to that channel's default unless the user has
  // already manually toggled it (the toggle below flips to a concrete
  // boolean, so we know not to override).
  const channelMeta = PRESET_CHANNELS.find((c) => c.name === channel);
  const channelDefault = useCustom ? true : (channelMeta?.webDefault ?? false);
  const [webResearch, setWebResearch] = useState<boolean>(channelDefault);
  const [webResearchTouched, setWebResearchTouched] = useState(false);

  // When channel changes (and user hasn't manually overridden), sync
  // to that channel's default.
  useEffect(() => {
    if (!webResearchTouched) {
      setWebResearch(channelDefault);
    }
  }, [channel, useCustom, channelDefault, webResearchTouched]);

  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    setError(null);
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        setError(`Skipped ${file.name}: not an image`);
        continue;
      }
      if (file.size > 4 * 1024 * 1024) {
        setError(`Skipped ${file.name}: must be < 4 MB (downscale in Photos/Preview first)`);
        continue;
      }
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch("/api/upload-image", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) {
          setError(`Upload failed: ${d.error || r.statusText}${d.next_step ? " — " + d.next_step : ""}`);
          continue;
        }
        setImages((prev) => [
          ...prev,
          { url: d.url, size: d.size, preview: URL.createObjectURL(file) },
        ]);
      } catch (e) {
        setError(`Upload failed: ${String(e)}`);
      }
    }
    setUploading(false);
  };

  const removeImage = (idx: number) => {
    setImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(idx, 1);
      if (removed) URL.revokeObjectURL(removed.preview);
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const finalChannel = useCustom && customChannel.trim() ? customChannel.trim() : channel;
      const body: Record<string, unknown> = {
        channel: finalChannel,
        dry_run: dryRun,
        // Only send the override if the user actually touched the toggle —
        // otherwise let the backend use the channel's default.
        ...(webResearchTouched ? { web_research: webResearch } : {}),
      };
      if (useCustom && customDesc.trim()) {
        body.manual_channel_desc = customDesc.trim();
      }
      if (mode === "topic" && topic.trim()) {
        body.manual_topic = topic.trim();
      }
      if (mode === "script" && script.trim()) {
        body.manual_script = script.trim();
      }
      if (title.trim()) body.manual_title = title.trim();
      if (images.length > 0) {
        body.manual_images = images.map((i) => i.url);
      }

      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || `HTTP ${r.status}`);
      } else {
        setSuccess(`Job ${d.id?.slice(0, 8) || "submitted"} queued. Track it on the Job queue page.`);
        // Clear the form so the user can submit another.
        setTopic("");
        setScript("");
        setTitle("");
        setImages([]);
      }
    } catch (e) {
      setError(String(e));
    }
    setSubmitting(false);
  };

  const canSubmit =
    !submitting &&
    !uploading &&
    ((mode === "topic" && topic.trim().length > 5) ||
     (mode === "script" && script.trim().length > 50));

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Wand2 className="h-6 w-6 text-accent" />
          Create a video
        </h1>
        <p className="text-sm text-neutral-400 max-w-2xl mt-1">
          Provide a topic or full script, optionally upload images, and the
          pipeline takes it from there. NIM refines your draft, adds a
          channel-appropriate hook, fills any missing visuals from stock
          providers, and renders the final Short.
        </p>
      </div>

      {/* Channel picker */}
      <div className="card space-y-3">
        <label className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          Channel / niche
        </label>
        {!useCustom && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {PRESET_CHANNELS.map((c) => (
              <button
                key={c.name}
                onClick={() => setChannel(c.name)}
                className={clsx(
                  "px-2.5 h-9 rounded-md border text-xs text-left transition",
                  channel === c.name
                    ? "border-accent/50 bg-accent/10 text-white"
                    : "border-line text-neutral-300 hover:border-neutral-500",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => setUseCustom(!useCustom)}
            className="text-xs text-accent hover:underline inline-flex items-center gap-1"
          >
            <Plus className="h-3 w-3" />
            {useCustom ? "Use a preset channel" : "Or define a custom niche"}
          </button>
        </div>
        {useCustom && (
          <div className="space-y-2">
            <input
              className="input w-full"
              placeholder="Channel name (e.g. 'street_photography', 'astrology', 'crypto_news')"
              value={customChannel}
              onChange={(e) => setCustomChannel(e.target.value)}
            />
            <textarea
              className="input w-full font-normal"
              placeholder="Brief description of the channel's voice + visuals. NIM uses this to build a full preset on the fly."
              rows={3}
              value={customDesc}
              onChange={(e) => setCustomDesc(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Topic OR script */}
      <div className="card space-y-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode("topic")}
            className={clsx(
              "px-3 h-8 rounded-md border text-sm transition",
              mode === "topic"
                ? "border-accent/50 bg-accent/10 text-white"
                : "border-line text-neutral-400 hover:text-neutral-200",
            )}
          >
            <Sparkles className="h-3.5 w-3.5 inline mr-1" />
            Topic seed
          </button>
          <button
            onClick={() => setMode("script")}
            className={clsx(
              "px-3 h-8 rounded-md border text-sm transition",
              mode === "script"
                ? "border-accent/50 bg-accent/10 text-white"
                : "border-line text-neutral-400 hover:text-neutral-200",
            )}
          >
            <FileText className="h-3.5 w-3.5 inline mr-1" />
            Full script
          </button>
        </div>

        {mode === "topic" ? (
          <>
            <label className="text-xs text-neutral-500">
              A short topic or premise. The LLM expands it into a full script
              tailored to the channel above.
            </label>
            <textarea
              className="input w-full"
              placeholder="e.g. 'how compound interest quietly builds wealth over 30 years' or 'the mystery of the Roanoke colony'"
              rows={4}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={1000}
            />
            <div className="text-xs text-neutral-500 text-right">{topic.length}/1000</div>
          </>
        ) : (
          <>
            <label className="text-xs text-neutral-500">
              Your full narration. The LLM lightly polishes phrasing and adds
              a 1-2 sentence hook at the start in the channel's style.
              <span className="text-amber-400"> Your content + voice are preserved.</span>
            </label>
            <textarea
              className="input w-full font-mono text-xs leading-relaxed"
              placeholder={"Paste your full script here.\n\nThe pipeline reads voice-out from this exact text (with a polished hook on top)."}
              rows={12}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              maxLength={20_000}
            />
            <div className="text-xs text-neutral-500 text-right">
              {script.length}/20,000 · ~{Math.round(script.split(/\s+/).filter(Boolean).length)} words
            </div>
          </>
        )}

        <input
          className="input w-full"
          placeholder="YouTube title (optional — auto-generated if blank)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
        />
      </div>

      {/* Image upload */}
      <div className="card space-y-3">
        <label className="text-sm font-medium flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-accent" />
          Images (optional)
          <span className="text-xs font-normal text-neutral-500">
            Used as shot footage. Missing slots are filled from stock providers.
          </span>
        </label>

        {images.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative aspect-square rounded-md overflow-hidden border border-line bg-bg-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.preview} alt="" className="absolute inset-0 w-full h-full object-cover" />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/70 hover:bg-red-500/70 flex items-center justify-center text-white"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
                <div className="absolute bottom-0 inset-x-0 text-[10px] text-white/80 bg-black/50 px-1 truncate">
                  {(img.size / 1024).toFixed(0)} KB
                </div>
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
            className="btn btn-ghost"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {uploading ? "Uploading…" : "Add images"}
          </button>
          <span className="text-xs text-neutral-500">JPG / PNG / WebP, &lt; 4 MB each</span>
        </div>
      </div>

      {/* Options + submit */}
      <div className="card space-y-3">
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="accent-accent mt-1"
            checked={webResearch}
            onChange={(e) => {
              setWebResearch(e.target.checked);
              setWebResearchTouched(true);
            }}
          />
          <span className="flex-1">
            <span className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-accent" />
              Web research (NIM browser agent)
              {!webResearchTouched && (
                <span className="text-[10px] text-neutral-500">
                  default for {channelMeta?.label || "this channel"}: {channelDefault ? "ON" : "OFF"}
                </span>
              )}
            </span>
            <span className="block text-xs text-neutral-500 mt-0.5">
              When ON: NIM controls a headless Chromium to fact-check the
              topic and pull real hero images. Adds ~30-60 sec to the run.
              When OFF: the script LLM works from prior knowledge only.
            </span>
          </span>
        </label>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="accent-accent"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          Dry run (don&apos;t upload to YouTube — render only)
        </label>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2.5 text-sm text-red-200 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-sm text-emerald-200">
            ✓ {success}
          </div>
        )}

        <div className="flex items-center justify-end pt-1">
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="btn btn-primary"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Queue render
          </button>
        </div>
      </div>
    </div>
  );
}
