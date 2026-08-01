"use client";

import { useEffect, useState } from "react";
import {
  Loader2, Save, Layers, CheckCircle2, AlertTriangle, Trash2, Info,
} from "lucide-react";

/**
 * Shared credential pool.
 *
 * Every tenant inherits these, with their own keys overriding per key.
 * This is what allows a customer to publish their first video after
 * connecting nothing but YouTube — previously they had to register
 * with eight separate providers first.
 *
 * Values are write-only: the API returns a masked preview so an
 * operator can see a credential is present without it being re-sent to
 * the browser on every page load.
 */

type Item = {
  key: string; group: string; label: string; help: string;
  has_value: boolean; preview: string;
};

export default function PoolPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    try {
      const r = await fetch("/api/superadmin/pool", { cache: "no-store" });
      if (r.ok) setItems((await r.json()).items || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (Object.keys(edits).length === 0) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/superadmin/pool", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: edits }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const bits: string[] = [];
        if (j.applied?.length) bits.push(`${j.applied.length} saved`);
        if (j.cleared?.length) bits.push(`${j.cleared.length} removed`);
        setMsg({ kind: "ok", text: `${bits.join(", ") || "No changes"}. Applies to the next render — no redeploy.` });
        setEdits({});
        await load();
      } else {
        setMsg({ kind: "err", text: j.error || `HTTP ${r.status}` });
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="card text-center py-12 text-neutral-500">
        <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading pool…
      </div>
    );
  }

  const groups = Array.from(new Set(items.map((i) => i.group)));
  const setCount = items.filter((i) => i.has_value).length;
  const dirty = Object.keys(edits).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Layers className="h-5 w-5 text-accent" /> Shared credential pool
          </h1>
          <p className="text-sm text-neutral-400 mt-1 max-w-2xl">
            Credentials every customer uses. With these set, a new user can
            publish after connecting only their YouTube account.
          </p>
        </div>
        <button onClick={save} disabled={busy || dirty === 0} className="btn btn-primary h-9 text-xs">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save{dirty > 0 ? ` (${dirty})` : ""}
        </button>
      </div>

      {msg && (
        <div className={
          "card text-sm flex items-start gap-2 " +
          (msg.kind === "ok"
            ? "border-success/30 bg-success/5 text-success"
            : "border-danger/30 bg-danger/5 text-red-300")
        }>
          {msg.kind === "ok" ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                             : <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className={
        "card flex items-start gap-2.5 text-sm " +
        (setCount === 0
          ? "border-warn/30 bg-warn/5 text-amber-200"
          : "border-line bg-white/[0.01] text-neutral-400")
      }>
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          {setCount === 0 ? (
            <>
              <b>Nothing pooled yet.</b> Until at least the script-writing and
              visuals groups are filled in, every customer must supply their own
              keys before they can render anything.
            </>
          ) : (
            <>
              <b>{setCount} credential{setCount === 1 ? "" : "s"} pooled.</b>{" "}
              A tenant who sets the same key in their own Connections page
              overrides the pooled one for their renders only.
            </>
          )}
        </div>
      </div>

      {groups.map((g) => (
        <div key={g} className="card space-y-4">
          <div className="text-sm font-medium">{g}</div>
          {items.filter((i) => i.group === g).map((it) => (
            <div key={it.key}>
              <label className="label flex items-center gap-2 flex-wrap">
                <span>{it.label}</span>
                <code className="text-[10px] text-neutral-600 normal-case">{it.key}</code>
                {it.has_value
                  ? <span className="pill pill-success">pooled</span>
                  : <span className="pill pill-muted">not set</span>}
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  className="input flex-1"
                  placeholder={it.has_value ? it.preview : "not set"}
                  value={edits[it.key] === "__CLEAR__" ? "" : (edits[it.key] ?? "")}
                  onChange={(e) => setEdits({ ...edits, [it.key]: e.target.value })}
                />
                {it.has_value && (
                  <button
                    onClick={() => setEdits({ ...edits, [it.key]: "__CLEAR__" })}
                    title="Remove from the pool"
                    className={
                      "btn h-10 px-3 " +
                      (edits[it.key] === "__CLEAR__" ? "border-danger text-red-300" : "")
                    }>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {it.help && <p className="text-[11px] text-neutral-500 mt-1">{it.help}</p>}
              {edits[it.key] === "__CLEAR__" && (
                <p className="text-[11px] text-red-300 mt-1">
                  Will be removed on save — customers without their own key lose this provider.
                </p>
              )}
              {it.has_value && edits[it.key] === undefined && (
                <p className="text-[11px] text-neutral-600 mt-0.5">
                  Leave blank to keep the current value.
                </p>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
