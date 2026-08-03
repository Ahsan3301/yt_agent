"use client";

import { useEffect, useState } from "react";
import {
  Loader2, Save, Layers, CheckCircle2, AlertTriangle, Trash2, Info, Activity,
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

type Health = {
  key: string; status: "ok" | "bad" | "error" | "unset";
  detail: string; working?: number; total?: number;
};

export default function PoolPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Liveness of each pooled credential. Every tenant renders on these,
  // so one expiring breaks the whole platform at once — and an expired
  // API key produces no event, the provider just starts 401ing.
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [healthAt, setHealthAt] = useState(0);
  const [checking, setChecking] = useState(false);

  const applyHealth = (d: { items?: Health[]; checked_at?: number }) => {
    const m: Record<string, Health> = {};
    for (const h of d.items || []) m[h.key] = h;
    setHealth(m);
    setHealthAt(Number(d.checked_at || 0));
  };

  const load = async () => {
    try {
      const [r, h] = await Promise.all([
        fetch("/api/superadmin/pool", { cache: "no-store" }),
        fetch("/api/superadmin/pool/health", { cache: "no-store" }),
      ]);
      if (r.ok) setItems((await r.json()).items || []);
      if (h.ok) applyHealth(await h.json().catch(() => ({})));
    } finally {
      setLoading(false);
    }
  };

  // Explicit rather than automatic: this costs one round trip per
  // provider, and the daily sweep keeps the stored status fresh.
  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/superadmin/pool/health", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ kind: "err", text: d.error || `HTTP ${r.status}` }); return; }
      applyHealth(d);
      setMsg(d.broken > 0
        ? { kind: "err", text: `${d.broken} pooled credential${d.broken === 1 ? " is" : "s are"} failing — every customer is affected.` }
        : { kind: "ok", text: `All ${d.items?.length || 0} pooled credentials verified.` });
    } finally {
      setChecking(false);
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
        <div className="flex items-center gap-2">
          <button onClick={runCheck} disabled={checking} className="btn h-9 text-xs">
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
            Test all keys
          </button>
          <button onClick={save} disabled={busy || dirty === 0} className="btn btn-primary h-9 text-xs">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save{dirty > 0 ? ` (${dirty})` : ""}
          </button>
        </div>
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
              {healthAt > 0 && (
                <span className="block mt-1 text-neutral-500">
                  Liveness last verified {_ago(healthAt)}. Checked automatically each morning.
                </span>
              )}
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
                <HealthPill h={health[it.key]} />
              </label>
              <div className="flex gap-2">
                <input
                  // Behaviour flags are settings, not secrets. Masking
                  // "1" to "••••" leaves no way to tell an enabled flag
                  // from a disabled one, which is the whole reason to
                  // look at the page.
                  type={it.group === "Pipeline behaviour" ? "text" : "password"}
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
              {health[it.key] && health[it.key].status !== "ok" && health[it.key].status !== "unset" && (
                <p className="text-[11px] text-red-300 mt-1">{health[it.key].detail}</p>
              )}
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

/** Liveness of one pooled credential. Silent on "unset" — the
 *  pooled/not-set pill already says that. */
function HealthPill({ h }: { h?: Health }) {
  if (!h || h.status === "unset") return null;
  if (h.status === "ok") {
    return <span className="pill pill-success" title={h.detail}>working</span>;
  }
  if (h.status === "bad") {
    return <span className="pill pill-danger" title={h.detail}>failing</span>;
  }
  return (
    <span className="pill pill-warn" title={h.detail}>
      {h.working !== undefined && h.total !== undefined ? `${h.working}/${h.total}` : "degraded"}
    </span>
  );
}

function _ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 90) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.floor(h / 24)} day(s) ago`;
}
