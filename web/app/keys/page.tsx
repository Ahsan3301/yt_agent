"use client";

import { useEffect, useState } from "react";
import { Save, ExternalLink, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { getKeys, putKeys, type KeyStatus } from "@/lib/api";

const KEYS_META: Array<{ name: string; label: string; url: string; hint?: string }> = [
  { name: "GROQ_API_KEY",            label: "Groq (LLM fallback)",  url: "https://console.groq.com/keys" },
  { name: "NVIDIA_NIM_API_KEY",      label: "NVIDIA NIM (LLM + vision judge)", url: "https://build.nvidia.com/" },
  { name: "SHUTTERSTOCK_API_TOKEN",  label: "Shutterstock user token", url: "https://www.shutterstock.com/account/developers/apps",
    hint: "Generate this from your app's Authentication tab. Needed for licensing." },
  { name: "SHUTTERSTOCK_CLIENT_ID",  label: "Shutterstock Consumer Key (optional)", url: "https://www.shutterstock.com/account/developers/apps" },
  { name: "SHUTTERSTOCK_CLIENT_SECRET", label: "Shutterstock Consumer Secret (optional)", url: "https://www.shutterstock.com/account/developers/apps" },
  { name: "PEXELS_API_KEY",          label: "Pexels", url: "https://www.pexels.com/api/" },
  { name: "PIXABAY_API_KEY",         label: "Pixabay", url: "https://pixabay.com/api/docs/" },
  { name: "COVERR_API_KEY",          label: "Coverr", url: "https://coverr.co/developers" },
];

export default function KeysPage() {
  const [keys, setKeys] = useState<Record<string, KeyStatus>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const refresh = () => getKeys().then(setKeys).catch(() => {});
  useEffect(() => { refresh(); }, []);

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
      await refresh();
    } catch (e) {
      alert("Save failed: " + (e as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
          <p className="text-sm text-neutral-400">Stored in <code>.env</code>. Existing values are masked.</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving || Object.keys(edits).length === 0}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save{Object.keys(edits).length ? ` (${Object.keys(edits).length})` : ""}
        </button>
      </div>

      <div className="space-y-3">
        {KEYS_META.map(({ name, label, url, hint }) => {
          const k = keys[name];
          const editing = edits[name] !== undefined;
          const isSet = !!k?.set;
          return (
            <div key={name} className="card space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{label}</div>
                  <div className="text-xs text-neutral-500 flex items-center gap-2 mt-0.5 flex-wrap">
                    <code>{name}</code>
                    <a href={url} target="_blank" className="text-accent hover:underline inline-flex items-center gap-1">
                      get key <ExternalLink className="h-3 w-3" />
                    </a>
                    {k?.managed && (
                      <span className="pill pill-info" title="Synced via Hostinger to all backends">
                        shared
                      </span>
                    )}
                  </div>
                </div>
                {isSet
                  ? <span className="pill pill-success"><CheckCircle2 className="h-3 w-3" /> set</span>
                  : <span className="pill pill-warn"><AlertCircle className="h-3 w-3" /> not set</span>}
              </div>
              {hint && <div className="text-xs text-neutral-500">{hint}</div>}
              <div className="flex gap-2">
                <input
                  type="password" autoComplete="off" className="input"
                  placeholder={isSet ? k.masked : "paste key here"}
                  value={edits[name] ?? ""}
                  onChange={(e) => setEdits({ ...edits, [name]: e.target.value })}
                />
                {isSet && !editing && (
                  <button className="btn" onClick={() => setEdits({ ...edits, [name]: "" })}>
                    Clear
                  </button>
                )}
                {editing && (
                  <button className="btn" onClick={() => { const e = { ...edits }; delete e[name]; setEdits(e); }}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
