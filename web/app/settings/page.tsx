"use client";

import { useEffect, useState } from "react";
import { Save, Loader2 } from "lucide-react";
import clsx from "clsx";
import { getSettings, putSettings, getEdgeVoices, type Settings } from "@/lib/api";

const TABS = ["Content", "Voice", "Video", "Upload", "Keywords", "Automation"] as const;
type Tab = typeof TABS[number];

const TONES = [
  "chilling", "extreme", "atmospheric", "dramatic",
  "educational", "sarcastic", "inspirational",
];
const CHANNELS = ["horror", "wisdom"];
const PRIVACIES = ["public", "unlisted", "private"];
const PRESETS = ["ultrafast", "fast", "medium", "slow"];
const AUDIO_BITRATES = ["64k", "96k", "128k", "192k"];

const PROVIDERS = [
  { key: "shutterstock",    label: "Shutterstock",   hint: "Premium licensed images (500/month free)." },
  { key: "pexels",          label: "Pexels",         hint: "Free stock videos + photos." },
  { key: "coverr",          label: "Coverr",         hint: "Curated cinematic clips (key required)." },
  { key: "pixabay",         label: "Pixabay",        hint: "Free stock videos + photos + music." },
  { key: "openverse_image", label: "Openverse",      hint: "CC0/CC-BY image aggregator (no key)." },
  { key: "pollinations",    label: "AI Generation",  hint: "Pollinations text-to-image (slow)." },
];

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("Content");
  const [voices, setVoices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    getSettings().then(setS).catch(() => {});
    getEdgeVoices().then(setVoices).catch(() => setVoices([]));
  }, []);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      await putSettings(s);
      setSavedAt(Date.now());
    } catch (e) {
      alert("Save failed: " + (e as Error).message);
    }
    setSaving(false);
  };

  if (!s) return <div className="text-neutral-400">Loading…</div>;

  // helpers
  const setContent = (k: keyof Settings["content"], v: any) =>
    setS({ ...s, content: { ...s.content, [k]: v } });
  const setVoice = (k: string, v: any) =>
    setS({ ...s, voice: { ...s.voice, [k]: v } });
  const setVideo = (k: string, v: any) =>
    setS({ ...s, video: { ...s.video, [k]: v } });
  const setUpload = (k: string, v: any) =>
    setS({ ...s, upload: { ...s.upload, [k]: v } });
  const setProvider = (k: string, v: boolean) =>
    setS({ ...s, providers: { ...s.providers, [k]: v } });
  const setKeywords = (channel: string, lines: string[]) =>
    setS({ ...s, keywords: { ...s.keywords, [channel]: lines } });
  const setMusicKw = (channel: string, q: string) =>
    setS({ ...s, music_keywords: { ...s.music_keywords, [channel]: q } });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-neutral-400">Tunable knobs — saved to <code>config/settings.json</code>.</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Saving…" : savedAt ? "Saved ✓" : "Save changes"}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              "px-4 py-2 text-sm font-medium border-b-2 transition",
              tab === t ? "border-accent text-white" : "border-transparent text-neutral-400 hover:text-white",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      {tab === "Content" && (
        <div className="card space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="label">Channel</label>
              <select className="select" value={s.content.channel}
                      onChange={(e) => setContent("channel", e.target.value)}>
                {CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Tone</label>
              <select className="select" value={s.content.tone}
                      onChange={(e) => setContent("tone", e.target.value)}>
                {TONES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Min words (narration)</label>
              <input type="number" className="input" value={s.content.target_word_min}
                     onChange={(e) => setContent("target_word_min", parseInt(e.target.value || "0"))} />
            </div>
            <div>
              <label className="label">Max words (narration)</label>
              <input type="number" className="input" value={s.content.target_word_max}
                     onChange={(e) => setContent("target_word_max", parseInt(e.target.value || "0"))} />
            </div>
            <div>
              <label className="label">Videos per run</label>
              <input type="number" className="input" min={1} value={s.content.videos_per_run}
                     onChange={(e) => setContent("videos_per_run", parseInt(e.target.value || "1"))} />
            </div>
          </div>
          <div>
            <label className="label">Manual premise override (optional)</label>
            <textarea className="textarea h-24" value={s.content.manual_premise}
                      onChange={(e) => setContent("manual_premise", e.target.value)}
                      placeholder='e.g. "Someone realizes every photo on their phone is dated tomorrow."' />
          </div>
        </div>
      )}

      {/* VOICE */}
      {tab === "Voice" && (
        <div className="space-y-4">
          <div className="card">
            <label className="label">TTS engine</label>
            <select className="select" value={s.voice.engine || "edge"}
                    onChange={(e) => setVoice("engine", e.target.value)}>
              <option value="edge">edge-tts (Microsoft, fast)</option>
              <option value="kokoro">kokoro (local, more natural)</option>
            </select>
          </div>
          {(["horror", "wisdom"] as const).map((ch) => (
            <div key={ch} className="card space-y-3">
              <div className="font-medium capitalize">{ch}</div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="label">edge voice</label>
                  <select className="select" value={s.voice[`edge_voice_${ch}`] || ""}
                          onChange={(e) => setVoice(`edge_voice_${ch}`, e.target.value)}>
                    {voices.map(v => <option key={v} value={v}>{v}</option>)}
                    {!voices.includes(s.voice[`edge_voice_${ch}`]) && (
                      <option value={s.voice[`edge_voice_${ch}`]}>{s.voice[`edge_voice_${ch}`]}</option>
                    )}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">rate</label>
                    <input className="input" value={s.voice[`edge_rate_${ch}`] || "+0%"}
                           onChange={(e) => setVoice(`edge_rate_${ch}`, e.target.value)} />
                  </div>
                  <div>
                    <label className="label">pitch</label>
                    <input className="input" value={s.voice[`edge_pitch_${ch}`] || "+0Hz"}
                           onChange={(e) => setVoice(`edge_pitch_${ch}`, e.target.value)} />
                  </div>
                </div>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="label">kokoro voice id</label>
                  <input className="input" value={s.voice[`kokoro_voice_${ch}`] || ""}
                         onChange={(e) => setVoice(`kokoro_voice_${ch}`, e.target.value)} />
                </div>
                <div>
                  <label className="label">kokoro speed: {s.voice[`kokoro_speed_${ch}`] ?? 0.9}</label>
                  <input type="range" min={0.5} max={1.5} step={0.05}
                         className="w-full accent-accent"
                         value={s.voice[`kokoro_speed_${ch}`] ?? 0.9}
                         onChange={(e) => setVoice(`kokoro_speed_${ch}`, parseFloat(e.target.value))} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* VIDEO */}
      {tab === "Video" && (
        <div className="space-y-4">
          <div className="card space-y-3">
            <div className="font-medium">Source media</div>
            <div className="grid md:grid-cols-2 gap-3">
              <Toggle
                checked={!!s.video.use_video_clips}
                onChange={(b) => setVideo("use_video_clips", b)}
                label="Fetch video clips"
                hint="Off = animated-stills mode."
              />
              <Toggle
                checked={!!s.video.allow_images}
                onChange={(b) => setVideo("allow_images", b)}
                label="Allow still images"
                hint="When clips run short."
              />
            </div>
          </div>

          <div className="card space-y-3">
            <div className="font-medium">Output encoder · file size</div>
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <label className="label">CRF (quality): {s.video.output_crf}</label>
                <input type="range" min={16} max={30} step={1}
                       className="w-full accent-accent"
                       value={s.video.output_crf ?? 23}
                       onChange={(e) => setVideo("output_crf", parseInt(e.target.value))} />
                <div className="text-xs text-neutral-500 mt-1">
                  18 ≈ lossless · 23 ≈ high · 26 ≈ small · 28 ≈ tiny
                </div>
              </div>
              <div>
                <label className="label">Preset</label>
                <select className="select" value={s.video.output_preset || "medium"}
                        onChange={(e) => setVideo("output_preset", e.target.value)}>
                  {PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Audio bitrate</label>
                <select className="select" value={s.video.output_audio_bitrate || "96k"}
                        onChange={(e) => setVideo("output_audio_bitrate", e.target.value)}>
                  {AUDIO_BITRATES.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="card space-y-3">
            <div className="font-medium">Pacing</div>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="label">Min seconds / clip: {s.video.min_segment_seconds}</label>
                <input type="range" min={1} max={6} step={0.5}
                       className="w-full accent-accent"
                       value={s.video.min_segment_seconds ?? 2.0}
                       onChange={(e) => setVideo("min_segment_seconds", parseFloat(e.target.value))} />
              </div>
              <div>
                <label className="label">Max seconds / clip: {s.video.max_segment_seconds}</label>
                <input type="range" min={2} max={12} step={0.5}
                       className="w-full accent-accent"
                       value={s.video.max_segment_seconds ?? 7.0}
                       onChange={(e) => setVideo("max_segment_seconds", parseFloat(e.target.value))} />
              </div>
            </div>
          </div>

          <div className="card space-y-3">
            <div className="font-medium">Background music</div>
            <div className="grid md:grid-cols-3 gap-3">
              <Slider label="Music volume" v={s.video.music_base_volume ?? 0.55}
                      min={0} max={1} step={0.05}
                      onChange={(v) => setVideo("music_base_volume", v)} />
              <Slider label="Duck threshold" v={s.video.music_duck_threshold ?? 0.15}
                      min={0.01} max={0.5} step={0.01}
                      onChange={(v) => setVideo("music_duck_threshold", v)} />
              <Slider label="Duck ratio" v={s.video.music_duck_ratio ?? 4.0}
                      min={1} max={12} step={0.5}
                      onChange={(v) => setVideo("music_duck_ratio", v)} />
            </div>
          </div>

          <div className="card space-y-3">
            <div className="font-medium">Captions (CapCut-style word highlight)</div>
            <div className="grid md:grid-cols-3 gap-3">
              <Slider label="Base size" v={s.video.caption_font_size ?? 72}
                      min={40} max={120} step={2}
                      onChange={(v) => setVideo("caption_font_size", v)} />
              <Slider label="Highlight size" v={s.video.caption_highlight_size ?? 90}
                      min={60} max={140} step={2}
                      onChange={(v) => setVideo("caption_highlight_size", v)} />
              <div>
                <label className="label">Highlight color (#RRGGBB)</label>
                <input className="input font-mono" value={"#" + bgrToRgb(s.video.caption_highlight_color_bgr || "00FFFF")}
                       onChange={(e) => setVideo("caption_highlight_color_bgr", rgbToBgr(e.target.value.replace("#","")))} />
              </div>
            </div>
          </div>

          <div className="card space-y-3">
            <div className="font-medium">Image effects + AI generation</div>
            <Slider label="Effects intensity" v={s.video.effects_intensity ?? 0.7}
                    min={0} max={1} step={0.05}
                    onChange={(v) => setVideo("effects_intensity", v)} />
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="label">AI images per run (0 = off)</label>
                <input type="number" className="input" min={0} max={20}
                       value={s.video.ai_image_count ?? 0}
                       onChange={(e) => setVideo("ai_image_count", parseInt(e.target.value || "0"))} />
              </div>
              <div>
                <label className="label">AI attempts per shot</label>
                <input type="number" className="input" min={1} max={5}
                       value={s.video.ai_image_attempts_per_shot ?? 3}
                       onChange={(e) => setVideo("ai_image_attempts_per_shot", parseInt(e.target.value || "3"))} />
              </div>
            </div>
            <Toggle checked={!!s.video.vision_judge_enabled}
                    onChange={(b) => setVideo("vision_judge_enabled", b)}
                    label="Vision-judge candidates before licensing"
                    hint="Saves Shutterstock quota by previewing first." />
            <div>
              <label className="label">Vision threshold (0-10): {s.video.vision_judge_threshold ?? 4}</label>
              <input type="range" min={0} max={10} step={1} className="w-full accent-accent"
                     value={s.video.vision_judge_threshold ?? 4}
                     onChange={(e) => setVideo("vision_judge_threshold", parseInt(e.target.value))} />
            </div>
          </div>

          <div className="card space-y-3">
            <div className="font-medium">Footage providers</div>
            <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
              {PROVIDERS.map((p) => (
                <Toggle key={p.key}
                        checked={!!s.providers[p.key]}
                        onChange={(b) => setProvider(p.key, b)}
                        label={p.label} hint={p.hint} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD */}
      {tab === "Upload" && (
        <div className="card space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="label">Privacy</label>
              <select className="select" value={s.upload.privacy}
                      onChange={(e) => setUpload("privacy", e.target.value)}>
                {PRIVACIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm pt-6">
              <input type="checkbox" className="h-4 w-4 accent-accent"
                     checked={!!s.upload.made_for_kids}
                     onChange={(e) => setUpload("made_for_kids", e.target.checked)} />
              Made for kids (COPPA)
            </label>
            <div>
              <label className="label">Category ID — horror</label>
              <input className="input" value={s.upload.category_horror || "24"}
                     onChange={(e) => setUpload("category_horror", e.target.value)} />
            </div>
            <div>
              <label className="label">Category ID — wisdom</label>
              <input className="input" value={s.upload.category_wisdom || "27"}
                     onChange={(e) => setUpload("category_wisdom", e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {/* KEYWORDS */}
      {tab === "Keywords" && (
        <div className="space-y-4">
          {(["horror","wisdom"] as const).map((ch) => (
            <div key={ch} className="card space-y-3">
              <div className="font-medium capitalize">{ch}</div>
              <div>
                <label className="label">Fallback keyword pool (one per line)</label>
                <textarea className="textarea h-44"
                          value={(s.keywords[ch] || []).join("\n")}
                          onChange={(e) => setKeywords(ch, e.target.value.split("\n").map(x => x.trim()).filter(Boolean))} />
              </div>
              <div>
                <label className="label">Background-music query</label>
                <input className="input" value={s.music_keywords[ch] || ""}
                       onChange={(e) => setMusicKw(ch, e.target.value)} />
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "Automation" && <AutomationTab />}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }:
  { checked: boolean; onChange: (b: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-3 card-tight cursor-pointer hover:bg-bg-2 transition">
      <button type="button" role="switch" aria-checked={checked}
              onClick={() => onChange(!checked)}
              className={clsx(
                "relative inline-flex h-5 w-9 shrink-0 rounded-full transition mt-0.5",
                checked ? "bg-accent" : "bg-bg-3",
              )}>
        <span className={clsx(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition",
          checked ? "left-4" : "left-0.5",
        )} />
      </button>
      <div className="text-sm">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-xs text-neutral-500">{hint}</div>}
      </div>
    </label>
  );
}

function Slider({ label, v, min, max, step, onChange }:
  { label: string; v: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="label">{label}: <span className="text-white font-mono">{v}</span></label>
      <input type="range" min={min} max={max} step={step} className="w-full accent-accent"
             value={v} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

// ── Automation tab ────────────────────────────────────────────
type ScheduleDoc = {
  enabled: boolean;
  daily_targets: Record<string, number>;
  publish_default: boolean;
  buffer_seconds: number;
};

function AutomationTab() {
  const [sched, setSched] = useState<ScheduleDoc | null>(null);
  const [savingS, setSavingS] = useState(false);
  const [savedSAt, setSavedSAt] = useState<number | null>(null);
  const [youtubeConnected, setYoutubeConnected] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [discordSet, setDiscordSet] = useState<boolean | null>(null);
  const [triggerKeySet, setTriggerKeySet] = useState<boolean | null>(null);

  // Read ?youtube= query param to show success/error toast.
  const [oauthResult, setOauthResult] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/schedule", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSched(d as ScheduleDoc))
      .catch(() => setSched({
        enabled: false,
        daily_targets: { horror: 1, wisdom: 0 },
        publish_default: true,
        buffer_seconds: 0,
      }));
    fetch("/api/keys", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setYoutubeConnected(!!d?.YOUTUBE_REFRESH_TOKEN?.set);
        setDiscordSet(!!d?.DISCORD_WEBHOOK_URL?.set);
        setTriggerKeySet(!!d?.RENDER_TRIGGER_KEY?.set);
      })
      .catch(() => {});
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      const yt = p.get("youtube");
      if (yt) setOauthResult(yt);
    }
  }, []);

  const saveSched = async () => {
    if (!sched) return;
    setSavingS(true);
    try {
      await fetch("/api/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sched),
      });
      setSavedSAt(Date.now());
    } catch {
      // ignored
    }
    setSavingS(false);
  };

  const connectYoutube = async () => {
    setConnecting(true);
    try {
      const r = await fetch("/api/youtube/auth");
      const d = await r.json();
      if (d.url) {
        window.location.href = d.url as string;
      } else {
        alert("YouTube auth not configured. Server returned: " + JSON.stringify(d));
      }
    } finally {
      setConnecting(false);
    }
  };

  const disconnectYoutube = async () => {
    if (!confirm("Disconnect YouTube? You'll need to re-grant consent to publish again.")) return;
    await fetch("/api/youtube/disconnect", { method: "POST" });
    setYoutubeConnected(false);
  };

  if (!sched) return <div className="text-sm text-neutral-400">Loading…</div>;

  return (
    <div className="space-y-6">
      {/* OAuth result toast */}
      {oauthResult === "connected" && (
        <div className="card border-emerald-500/30 bg-emerald-500/5 text-sm text-emerald-200">
          ✓ YouTube connected. Refresh token stored in Firestore.
        </div>
      )}
      {oauthResult && oauthResult !== "connected" && (
        <div className="card border-red-500/30 bg-red-500/5 text-sm text-red-200">
          YouTube connection failed: <code>{oauthResult}</code>. Check Vercel env vars
          (YOUTUBE_OAUTH_CLIENT_ID + YOUTUBE_OAUTH_CLIENT_SECRET) and the authorised
          redirect URI in Google Cloud Console.
        </div>
      )}

      {/* ── Discord webhook status ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold">Discord alerts</div>
            <div className="text-xs text-neutral-500">
              Pipeline completes, failures, cleanup summaries, YouTube publishes.
            </div>
          </div>
          <span className={clsx("pill", discordSet ? "pill-success" : "pill-muted")}>
            {discordSet === null ? "..." : discordSet ? "configured" : "not set"}
          </span>
        </div>
        {!discordSet && (
          <div className="text-xs text-neutral-400">
            Set <code>DISCORD_WEBHOOK_URL</code> on the API Keys page. Get a webhook
            URL from Discord: Server Settings → Integrations → Webhooks → New Webhook.
          </div>
        )}
      </div>

      {/* ── YouTube connection ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold">YouTube auto-publish</div>
            <div className="text-xs text-neutral-500">
              One-time OAuth grant. Refresh token survives container restarts (stored in Firestore).
            </div>
          </div>
          <span className={clsx("pill", youtubeConnected ? "pill-success" : "pill-muted")}>
            {youtubeConnected === null ? "..." : youtubeConnected ? "connected" : "not connected"}
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          {!youtubeConnected ? (
            <button onClick={connectYoutube} disabled={connecting} className="btn btn-primary">
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Connect YouTube
            </button>
          ) : (
            <button onClick={disconnectYoutube} className="btn btn-ghost">Disconnect</button>
          )}
        </div>
      </div>

      {/* ── Scheduler ── */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold">Scheduled renders</div>
            <div className="text-xs text-neutral-500">
              GitHub Actions cron fires daily at 09:00 UTC and calls the Vercel
              gateway. Toggle on to start daily renders.
            </div>
          </div>
          <span className={clsx("pill", sched.enabled ? "pill-success" : "pill-muted")}>
            {sched.enabled ? "active" : "disabled"}
          </span>
        </div>

        <Toggle
          checked={sched.enabled}
          onChange={(b) => setSched({ ...sched, enabled: b })}
          label="Enable scheduled renders"
          hint="When off, the daily cron is a no-op. When on, queues videos per channel."
        />

        {sched.enabled && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(["horror", "wisdom"] as const).map((ch) => (
                <Slider
                  key={ch}
                  label={`${ch} videos / day`}
                  v={sched.daily_targets[ch] ?? 0}
                  min={0}
                  max={10}
                  step={1}
                  onChange={(v) => setSched({
                    ...sched,
                    daily_targets: { ...sched.daily_targets, [ch]: v },
                  })}
                />
              ))}
            </div>

            <Toggle
              checked={sched.publish_default}
              onChange={(b) => setSched({ ...sched, publish_default: b })}
              label="Publish scheduled renders to YouTube"
              hint="If off, scheduled renders are dry-runs — same as manual 'Run pipeline now' from the dashboard."
            />
          </>
        )}

        {triggerKeySet === false && (
          <div className="text-xs text-amber-300">
            ⚠ <code>RENDER_TRIGGER_KEY</code> is not set on the API Keys page yet —
            without it, GitHub Actions can't authenticate to call the scheduled-render
            route. Generate a random string and paste it both as the Firestore value
            AND as a GitHub repository secret.
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line pt-3">
          <div className="text-xs text-neutral-500">
            {savedSAt && Date.now() - savedSAt < 4000 ? "Saved." : ""}
          </div>
          <button className="btn btn-primary" onClick={saveSched} disabled={savingS}>
            {savingS ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save schedule
          </button>
        </div>
      </div>
    </div>
  );
}

function bgrToRgb(bgr: string): string {
  const x = (bgr || "").replace("#","").toUpperCase().padStart(6, "0").slice(0, 6);
  return x.slice(4,6) + x.slice(2,4) + x.slice(0,2);
}
function rgbToBgr(rgb: string): string {
  const x = (rgb || "").replace("#","").toUpperCase().padStart(6, "0").slice(0, 6);
  return x.slice(4,6) + x.slice(2,4) + x.slice(0,2);
}
