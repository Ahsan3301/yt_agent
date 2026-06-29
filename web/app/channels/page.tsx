"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  Sparkles, Plus, Trash2, Globe, Edit3, Save, X as XIcon, Loader2,
  CheckCircle2, AlertCircle, Wand2, Film, Layers,
} from "lucide-react";
import {
  PRESET_CHANNELS, loadCustomChannels, addCustomChannel,
  removeCustomChannel, type ChannelPreset,
} from "@/lib/channels";
import { useToast } from "@/components/Toast";

/**
 * Channels manager — one screen to add, view, edit, and remove user-
 * defined niches. Built-in presets are read-only; user-defined ones
 * can be renamed/deleted. Selecting a channel here doesn't run a
 * job — for that, the Create / Dashboard pages have their own
 * pickers. This page is purely for managing the LIST.
 */
export default function ChannelsPage() {
  const toast = useToast();
  const [savedCustom, setSavedCustom] = useState<ChannelPreset[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  useEffect(() => {
    setSavedCustom(loadCustomChannels());
  }, []);

  const addNew = () => {
    if (!name.trim()) {
      toast.warn("Name required", "Type a channel name first.");
      return;
    }
    addCustomChannel({ name: name.trim(), description: desc.trim() });
    setSavedCustom(loadCustomChannels());
    const norm = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    toast.success("Saved", `"${norm}" is now in every picker.`);
    setName("");
    setDesc("");
    setShowAdd(false);
  };

  const removeOne = (slug: string) => {
    if (!confirm(`Forget "${slug}"? It won't be selectable on any picker until re-added.`)) return;
    removeCustomChannel(slug);
    setSavedCustom(loadCustomChannels());
    toast.info("Removed", `"${slug}" is gone from your custom list.`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6 text-accent" />
            Channels
          </h1>
          <p className="text-sm text-neutral-400 max-w-2xl mt-1">
            Built-in niche presets + the custom ones you&apos;ve saved.
            Custom niches persist on this device (browser localStorage).
            They show up automatically on every channel picker.
          </p>
        </div>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="btn btn-primary h-9 text-sm">
            <Plus className="h-4 w-4" />
            Define a custom niche
          </button>
        )}
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="card space-y-3 border-accent/30">
          <div className="font-medium flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-accent" />
            New custom niche
          </div>
          <input
            className="input w-full"
            placeholder="Channel name (e.g. astrology, crypto_news, indie_films)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <textarea
            className="input w-full font-normal"
            placeholder="Brief description: voice, tone, visual style. NIM uses this to build a full preset on the fly when the worker boots."
            rows={3}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => { setShowAdd(false); setName(""); setDesc(""); }}
                    className="btn btn-ghost h-8 text-xs">
              <XIcon className="h-3 w-3" /> Cancel
            </button>
            <button onClick={addNew} disabled={!name.trim()} className="btn btn-primary h-8 text-xs">
              <Save className="h-3 w-3" /> Save niche
            </button>
          </div>
        </div>
      )}

      {/* Built-in presets */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-neutral-500">Built-in presets</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {PRESET_CHANNELS.map((c) => (
            <ChannelCard
              key={c.name}
              channel={c}
              isCustom={false}
            />
          ))}
        </div>
      </div>

      {/* Custom niches */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-neutral-500 flex items-center gap-2">
          Your custom niches
          <span className="text-[10px] text-neutral-600">stored locally</span>
        </div>
        {savedCustom.length === 0 ? (
          <div className="card text-sm text-neutral-500 text-center py-6">
            No custom niches yet. Click &quot;Define a custom niche&quot; above to add one.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {savedCustom.map((c) => (
              <ChannelCard
                key={c.name}
                channel={c}
                isCustom
                onRemove={() => removeOne(c.name)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="card text-xs text-neutral-500 space-y-1">
        <div className="font-medium text-neutral-300">How channels work</div>
        <p>
          Built-in presets live in <code className="font-mono">modules/channels.py</code> on the
          worker. Custom niches you define here ship only the name + description as
          part of each job; NIM expands them into a full preset (tone, voice,
          color grade, hook style, footage keywords, image style) on the worker
          when the job claims.
        </p>
        <p>
          To run a render: pick a niche on the <Link href="/" className="text-accent">Dashboard</Link> or open the
          full <Link href="/create" className="text-accent">Create</Link> form.
        </p>
      </div>
    </div>
  );
}

function ChannelCard({
  channel, isCustom, onRemove,
}: {
  channel: ChannelPreset;
  isCustom: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className={clsx(
      "card space-y-2 transition",
      isCustom ? "border-dashed" : "",
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium truncate">{channel.label}</div>
          <code className="text-xs text-neutral-500">{channel.name}</code>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {channel.webDefault && (
            <span className="pill pill-info text-[10px]" title="Web research defaults ON for this niche">
              <Globe className="h-3 w-3" /> research
            </span>
          )}
          {!isCustom && (
            <span className="pill pill-muted text-[10px]">built-in</span>
          )}
        </div>
      </div>
      {channel.description && (
        <p className="text-xs text-neutral-400 line-clamp-3">{channel.description}</p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Link
          href={`/create?channel=${encodeURIComponent(channel.name)}`}
          className="btn btn-ghost h-7 text-xs"
        >
          <Wand2 className="h-3 w-3" />
          Create
        </Link>
        {isCustom && (
          <button
            onClick={onRemove}
            className="btn btn-ghost h-7 text-xs text-neutral-400 hover:text-red-300"
          >
            <Trash2 className="h-3 w-3" />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
