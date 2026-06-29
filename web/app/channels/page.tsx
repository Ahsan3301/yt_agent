"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  Layers, Plus, Trash2, Globe, Loader2, Save, X as XIcon,
  PauseCircle, PlayCircle, Edit3, Wand2,
} from "lucide-react";
import { PRESET_CHANNELS } from "@/lib/channels";
import { useToast } from "@/components/Toast";

/**
 * Channels manager — multi-channel scheduling.
 *
 * Each channel doc lives in Firestore at `channels/<id>` and has:
 *   - name (display)
 *   - niche (one of presets or a custom slug)
 *   - daily_count (0-10 videos per day at 09:00 UTC cron)
 *   - enabled (paused or active)
 *   - description (free text, used when niche is custom)
 *   - web_research (true/false/null — null = use niche default)
 *
 * Scheduled-render iterates this collection — each enabled channel
 * with daily_count > 0 produces that many jobs per day.
 */
type Channel = {
  id: string;
  name: string;
  niche: string;
  daily_count: number;
  enabled: boolean;
  description?: string;
  web_research?: boolean | null;
  real_events?: boolean | null;
  language?: string;
  voice?: string | null;
};

// Stay in sync with web/app/create/wizard/page.tsx WIZARD_LANGUAGES.
const CHANNEL_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ur", label: "Urdu (اردو)" },
  { code: "hi", label: "Hindi (हिंदी)" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ar", label: "Arabic" },
  { code: "pt", label: "Portuguese" },
];

// Same catalog as the wizard; surface in the channel settings so the
// per-channel default voice can be chosen here.
const CHANNEL_VOICE_CATALOG: Record<string, Record<string, string[]>> = {
  horror:  { en: ["en-US-BrianMultilingualNeural","en-US-ChristopherNeural","en-GB-RyanNeural","en-US-GuyNeural"], ur: ["ur-PK-AsadNeural","ur-PK-UzmaNeural"], hi: ["hi-IN-MadhurNeural","hi-IN-SwaraNeural"] },
  wisdom:  { en: ["en-US-AndrewMultilingualNeural","en-US-RogerNeural","en-GB-ThomasNeural","en-US-EricNeural"], ur: ["ur-PK-AsadNeural"], hi: ["hi-IN-MadhurNeural"] },
  finance: { en: ["en-US-GuyNeural","en-US-AndrewMultilingualNeural","en-US-DavisNeural","en-GB-ThomasNeural"], ur: ["ur-PK-AsadNeural"], hi: ["hi-IN-MadhurNeural"] },
  fitness: { en: ["en-US-DavisNeural","en-US-GuyNeural","en-US-RogerNeural","en-US-BrianMultilingualNeural"], ur: ["ur-PK-AsadNeural"], hi: ["hi-IN-MadhurNeural"] },
  science: { en: ["en-US-AriaNeural","en-US-JennyNeural","en-GB-LibbyNeural","en-US-EmmaMultilingualNeural"], ur: ["ur-PK-UzmaNeural"], hi: ["hi-IN-SwaraNeural"] },
  history: { en: ["en-US-ChristopherNeural","en-GB-RyanNeural","en-US-AndrewMultilingualNeural","en-GB-ThomasNeural"], ur: ["ur-PK-AsadNeural"], hi: ["hi-IN-MadhurNeural"] },
  comedy:  { en: ["en-US-JennyNeural","en-US-AriaNeural","en-US-EmmaMultilingualNeural","en-US-GuyNeural"], ur: ["ur-PK-UzmaNeural"], hi: ["hi-IN-SwaraNeural"] },
  food:    { en: ["en-US-JaneNeural","en-US-EmmaMultilingualNeural","en-US-AriaNeural","en-GB-SoniaNeural"], ur: ["ur-PK-UzmaNeural"], hi: ["hi-IN-SwaraNeural"] },
  travel:  { en: ["en-US-EmmaMultilingualNeural","en-US-JaneNeural","en-GB-SoniaNeural","en-US-AndrewMultilingualNeural"], ur: ["ur-PK-UzmaNeural"], hi: ["hi-IN-SwaraNeural"] },
  gaming:  { en: ["en-US-RogerNeural","en-US-DavisNeural","en-US-GuyNeural","en-US-BrianMultilingualNeural"], ur: ["ur-PK-AsadNeural"], hi: ["hi-IN-MadhurNeural"] },
};

export default function ChannelsPage() {
  const toast = useToast();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/channels", { cache: "no-store" });
      const d = await r.json();
      setChannels(Array.isArray(d) ? d : []);
    } catch (e) {
      toast.error("Couldn't load channels", String(e));
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const save = async (c: Channel) => {
    try {
      const r = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error("Save failed", d.error || `HTTP ${r.status}`);
        return false;
      }
      toast.success("Saved", `"${d.name || c.name}" updated.`);
      await refresh();
      return true;
    } catch (e) {
      toast.error("Save failed", String(e));
      return false;
    }
  };

  const remove = async (id: string) => {
    if (!confirm(`Delete channel "${id}"? This won't delete past renders.`)) return;
    try {
      const r = await fetch(`/api/channels?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        toast.error("Delete failed", `HTTP ${r.status}`);
        return;
      }
      toast.info("Deleted", `"${id}" removed.`);
      await refresh();
    } catch (e) {
      toast.error("Delete failed", String(e));
    }
  };

  const togglePause = async (c: Channel) => {
    await save({ ...c, enabled: !c.enabled });
  };

  // Aggregate quota math
  const totalDaily = channels
    .filter((c) => c.enabled)
    .reduce((acc, c) => acc + (c.daily_count || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6 text-accent" />
            Channels
          </h1>
          <p className="text-sm text-neutral-400 max-w-2xl mt-1">
            Every YouTube channel you publish to. Each one maps to a
            niche and picks how many videos it queues per day. The
            scheduler at 09:00 UTC reads this list and queues
            <span className="font-semibold text-neutral-200"> {totalDaily} job{totalDaily === 1 ? "" : "s"} </span>
            today across all enabled channels.
          </p>
        </div>
        {!showNew && !editing && (
          <button onClick={() => setShowNew(true)} className="btn btn-primary h-9 text-sm">
            <Plus className="h-4 w-4" /> New channel
          </button>
        )}
      </div>

      {(showNew || editing) && (
        <ChannelForm
          initial={editing}
          onCancel={() => { setShowNew(false); setEditing(null); }}
          onSave={async (c) => {
            const ok = await save(c);
            if (ok) {
              setShowNew(false);
              setEditing(null);
            }
          }}
        />
      )}

      {loading && channels.length === 0 ? (
        <div className="card text-center text-neutral-500 py-10">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
          Loading channels…
        </div>
      ) : channels.length === 0 ? (
        <div className="card text-center text-sm text-neutral-500 py-10">
          No channels yet. Click <b>New channel</b> to add your first one.
        </div>
      ) : (
        <div className="space-y-2">
          {channels.map((c) => (
            <ChannelCard
              key={c.id}
              channel={c}
              onEdit={() => setEditing(c)}
              onDelete={() => remove(c.id)}
              onTogglePause={() => togglePause(c)}
            />
          ))}
        </div>
      )}

      <div className="card text-xs text-neutral-500 space-y-1">
        <div className="font-medium text-neutral-300">How channels + scheduler work</div>
        <p>
          Channels here are the <b>destinations</b>. Niches (horror, finance,
          science, etc.) define the content style. Each channel maps to one niche
          and picks its own publish frequency.
        </p>
        <p>
          The scheduled-render workflow (GitHub Actions cron, 09:00 UTC) iterates
          this collection and queues jobs accordingly. Paused channels are
          skipped — their daily_count doesn&apos;t matter while paused.
        </p>
      </div>
    </div>
  );
}

function ChannelCard({
  channel: c, onEdit, onDelete, onTogglePause,
}: {
  channel: Channel;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePause: () => void;
}) {
  const nichePreset = PRESET_CHANNELS.find((p) => p.name === c.niche);
  return (
    <div className={clsx(
      "card flex items-center gap-3 flex-wrap",
      !c.enabled && "opacity-50",
    )}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-semibold">{c.name}</div>
          <code className="text-xs text-neutral-500">{c.id}</code>
          {!c.enabled && (
            <span className="pill pill-muted text-[10px]">paused</span>
          )}
          {c.web_research === true && (
            <span className="pill pill-info text-[10px]"><Globe className="h-3 w-3" /> research</span>
          )}
        </div>
        <div className="text-xs text-neutral-400 mt-0.5">
          niche: <span className="text-neutral-200">{nichePreset?.label || c.niche}</span>
          {c.description && <span> · {c.description}</span>}
        </div>
      </div>
      <div className="text-right">
        <div className="text-2xl font-mono font-semibold text-accent">
          {c.daily_count}
        </div>
        <div className="text-[10px] text-neutral-500 uppercase tracking-wider">
          videos/day
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button onClick={onTogglePause} className="btn btn-ghost h-7 text-xs" title={c.enabled ? "Pause" : "Resume"}>
          {c.enabled ? <PauseCircle className="h-3 w-3" /> : <PlayCircle className="h-3 w-3" />}
        </button>
        <button onClick={onEdit} className="btn btn-ghost h-7 text-xs" title="Edit">
          <Edit3 className="h-3 w-3" /> Edit
        </button>
        <button onClick={onDelete} className="btn btn-ghost h-7 text-xs text-neutral-400 hover:text-red-300" title="Delete">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function ChannelForm({
  initial, onSave, onCancel,
}: {
  initial: Channel | null;
  onSave: (c: Channel) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [niche, setNiche] = useState(initial?.niche || PRESET_CHANNELS[0].name);
  const [customNicheMode, setCustomNicheMode] = useState(
    !!(initial?.niche && !PRESET_CHANNELS.some((p) => p.name === initial.niche)),
  );
  const [dailyCount, setDailyCount] = useState(initial?.daily_count ?? 1);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [description, setDescription] = useState(initial?.description || "");
  const [webResearch, setWebResearch] = useState<"default" | "on" | "off">(
    initial?.web_research === true ? "on" :
    initial?.web_research === false ? "off" : "default"
  );
  const [realEvents, setRealEvents] = useState<"default" | "on" | "off">(
    initial?.real_events === true ? "on" :
    initial?.real_events === false ? "off" : "default"
  );
  const [language, setLanguage] = useState(initial?.language || "en");
  const [voice, setVoice] = useState(initial?.voice || "");

  const submit = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || "",
      name: name.trim(),
      niche: niche.trim() || "horror",
      daily_count: Math.max(0, Math.min(10, dailyCount)),
      enabled,
      description: description.trim(),
      web_research:
        webResearch === "on" ? true :
        webResearch === "off" ? false : null,
      real_events:
        realEvents === "on" ? true :
        realEvents === "off" ? false : null,
      language,
      voice: voice || null,
    });
  };

  return (
    <div className="card space-y-4 border-accent/30">
      <div className="font-semibold flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-accent" />
        {initial ? `Edit "${initial.name}"` : "New channel"}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="label">Channel name</label>
          <input
            className="input w-full"
            placeholder="e.g. Tales from the Vault"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!initial}
          />
          <div className="text-[10px] text-neutral-500 mt-1">
            How it appears in your queue + Discord alerts.
          </div>
        </div>
        <div>
          <label className="label">Niche</label>
          {!customNicheMode ? (
            <>
              <select
                className="select"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
              >
                {PRESET_CHANNELS.map((p) => (
                  <option key={p.name} value={p.name}>{p.label}</option>
                ))}
              </select>
              <button
                onClick={() => { setCustomNicheMode(true); setNiche(""); }}
                className="text-[10px] text-accent hover:underline mt-1"
              >
                or define a custom niche
              </button>
            </>
          ) : (
            <>
              <input
                className="input w-full"
                placeholder="e.g. crypto_news, astrology, indie_films"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
              />
              <button
                onClick={() => { setCustomNicheMode(false); setNiche(PRESET_CHANNELS[0].name); }}
                className="text-[10px] text-accent hover:underline mt-1"
              >
                or pick a preset niche
              </button>
            </>
          )}
        </div>
      </div>

      <div>
        <label className="label">
          Videos per day: <span className="text-accent font-mono">{dailyCount}</span>
          {dailyCount === 0 && <span className="text-amber-300 ml-2">(paused — never publishes)</span>}
        </label>
        <input
          type="range" min={0} max={10} step={1}
          value={dailyCount}
          onChange={(e) => setDailyCount(parseInt(e.target.value, 10))}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-[10px] text-neutral-500 mt-0.5">
          <span>0 (off)</span><span>5</span><span>10</span>
        </div>
      </div>

      {customNicheMode && (
        <div>
          <label className="label">Niche description (custom only)</label>
          <textarea
            className="input w-full"
            rows={2}
            placeholder="Brief description of the channel's voice + visuals. NIM uses this to build a full preset on the fly."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="label">Language</label>
          <select
            className="select"
            value={language}
            onChange={(e) => { setLanguage(e.target.value); setVoice(""); }}
          >
            {CHANNEL_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          <div className="text-[10px] text-neutral-500 mt-1">
            Script + voice language. Non-English uses edge-tts.
          </div>
        </div>
        <div>
          <label className="label">Voice (optional)</label>
          <select
            className="select"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
          >
            <option value="">Niche default for {language}</option>
            {(CHANNEL_VOICE_CATALOG[niche]?.[language] || []).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <div className="text-[10px] text-neutral-500 mt-1">
            Override the niche&apos;s default voice for this language.
          </div>
        </div>
      </div>

      <div>
        <label className="label">Web research (NIM browser agent)</label>
        <div className="flex gap-1">
          {(["default", "on", "off"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setWebResearch(v)}
              className={clsx(
                "px-2.5 h-7 rounded-md border text-xs",
                webResearch === v
                  ? "border-accent/50 bg-accent/10 text-white"
                  : "border-line text-neutral-400 hover:text-neutral-200",
              )}
            >
              {v === "default" ? "Niche default" : v.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-neutral-500 mt-1">
          When ON, NIM controls a headless Chromium for facts + hero images.
          Adds ~30-60 sec per render.
        </div>
      </div>

      <div>
        <label className="label">Real events mode</label>
        <div className="flex gap-1">
          {(["default", "on", "off"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setRealEvents(v)}
              className={clsx(
                "px-2.5 h-7 rounded-md border text-xs",
                realEvents === v
                  ? "border-accent/50 bg-accent/10 text-white"
                  : "border-line text-neutral-400 hover:text-neutral-200",
              )}
            >
              {v === "default" ? "Off" : v.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-neutral-500 mt-1">
          When ON, the script must be grounded in documented real events
          (or accurately retold mythology). Niche-aware framing — true
          horror story / real case study / documented experiment / etc.
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox" className="accent-accent"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Channel enabled
        <span className="text-xs text-neutral-500">(uncheck to pause the scheduler for this channel)</span>
      </label>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
        <button onClick={onCancel} className="btn btn-ghost h-8 text-xs">
          <XIcon className="h-3 w-3" /> Cancel
        </button>
        <button onClick={submit} disabled={!name.trim()} className="btn btn-primary h-8 text-xs">
          <Save className="h-3 w-3" /> {initial ? "Save changes" : "Create channel"}
        </button>
      </div>
    </div>
  );
}
