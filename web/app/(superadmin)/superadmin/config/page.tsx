"use client";

import { useEffect, useState } from "react";
import {
  Loader2, Save, SlidersHorizontal, Database, Lock, HardDriveDownload,
  KeyRound, Wrench, CheckCircle2, AlertTriangle, Trash2, Mail, Send,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

/**
 * Platform configuration editor.
 *
 * Everything here takes effect within a second of saving — values are
 * stored in PocketBase and override the corresponding environment
 * variable at runtime, so operational changes (rotating a credential,
 * pointing backups at a new bucket) no longer need a redeploy.
 *
 * Each field shows where its current value is coming from, which
 * matters: a key still served from the environment behaves identically
 * but can't be changed from here until it's overridden.
 */

type Item = {
  key: string;
  category: string;
  label: string;
  help: string;
  secret: boolean;
  value: string;
  preview: string;
  has_value: boolean;
  source: "database" | "environment" | "unset";
  env_only: boolean;
};

const CATEGORIES: Array<{ id: string; label: string; blurb: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "backup", label: "Backups",      icon: HardDriveDownload,
    blurb: "Nightly offsite copies of the database and rendered media. Until these are set, the backup job runs and exits without doing anything." },
  { id: "oauth",  label: "Connections",  icon: KeyRound,
    blurb: "Credentials for the services Yven talks to on your behalf." },
  { id: "email",  label: "Email (SMTP)", icon: Mail,
    blurb: "Where contact, quote and custom-niche submissions get delivered. Settings apply to the very next email — no redeploy. Until a host is set, forms still save to the database and nothing is lost; you just won't be emailed about them. Use Send test email below to confirm it works before you rely on it." },
  { id: "retention", label: "Retention", icon: Trash2,
    blurb: "How long each kind of data is kept before the nightly sweep removes it. Blank uses the built-in default; values under 1 day are ignored rather than obeyed. Deleting a video file does not remove it from the Library — published videos keep playing from YouTube." },
  { id: "ops",    label: "Operations",   icon: Wrench,
    blurb: "Internal plumbing — alerting, maintenance auth, worker access." },
];

export default function PlatformConfigPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  // Sends using the SAVED settings, not the typed ones — the server has
  // no idea what is in the inputs. The button is disabled while there
  // are unsaved edits so a "test" can never report on a stale password.
  const testEmail = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch("/api/superadmin/config/test-email", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      setTestResult({
        ok: Boolean(j.ok),
        detail: j.detail || j.error || `HTTP ${r.status}`,
      });
    } catch (e) {
      setTestResult({ ok: false, detail: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const load = async () => {
    try {
      const r = await fetch("/api/superadmin/config", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setItems(d.items || []);
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (Object.keys(edits).length === 0) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/superadmin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: edits }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const parts: string[] = [];
        if (j.applied?.length) parts.push(`${j.applied.length} updated`);
        if (j.cleared?.length) parts.push(`${j.cleared.length} reset to environment`);
        setMsg({ kind: "ok", text: `Saved — ${parts.join(", ") || "no changes"}. Live now; no redeploy needed.` });
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
        <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> loading configuration…
      </div>
    );
  }

  const dirty = Object.keys(edits).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Superadmin"
        icon={SlidersHorizontal}
        title="Platform configuration"
        subtitle="Changes here are live within a second — no redeploy. Values set here override the server environment."
        actions={
          <button onClick={save} disabled={busy || dirty === 0} className="btn btn-primary h-9 text-xs">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save{dirty > 0 ? ` (${dirty})` : ""}
          </button>
        }
      />

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

      {CATEGORIES.map((cat) => {
        const rows = items.filter((i) => i.category === cat.id);
        if (rows.length === 0) return null;
        const Icon = cat.icon;
        return (
          <div key={cat.id} className="card space-y-4">
            <div>
              <div className="text-sm font-medium flex items-center gap-2">
                <Icon className="h-4 w-4 text-accent" /> {cat.label}
              </div>
              <p className="text-xs text-neutral-500 mt-1 max-w-2xl">{cat.blurb}</p>
            </div>

            <div className="space-y-4">
              {rows.map((it) => (
                <div key={it.key}>
                  <label className="label flex items-center gap-2 flex-wrap">
                    <span>{it.label}</span>
                    <code className="text-[10px] text-neutral-600 normal-case">{it.key}</code>
                    <SourceBadge source={it.source} envOnly={it.env_only} />
                  </label>

                  <input
                    type={it.secret ? "password" : "text"}
                    className="input"
                    disabled={it.env_only}
                    placeholder={
                      it.env_only ? "set in the server environment"
                      : it.has_value ? (it.secret ? it.preview : "")
                      : "not set"
                    }
                    value={edits[it.key] ?? (it.secret ? "" : it.value)}
                    onChange={(e) => setEdits({ ...edits, [it.key]: e.target.value })}
                  />

                  {it.help && (
                    <p className="text-[11px] text-neutral-500 mt-1">{it.help}</p>
                  )}
                  {it.secret && it.has_value && (
                    <p className="text-[11px] text-neutral-600 mt-0.5">
                      Currently <code>{it.preview}</code> — leave blank to keep it.
                    </p>
                  )}
                  {!it.env_only && it.source === "database" && (
                    <p className="text-[11px] text-neutral-600 mt-0.5">
                      Clear the field and save to fall back to the environment value.
                    </p>
                  )}
                </div>
              ))}
            </div>

            {cat.id === "email" && (
              <div className="border-t border-line/60 pt-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={testEmail}
                    disabled={testing || dirty > 0}
                    className="btn btn-ghost h-8 text-xs"
                    title={dirty > 0 ? "Save your changes first" : "Send a test message using the saved settings"}
                  >
                    {testing
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</>
                      : <><Send className="h-3.5 w-3.5" /> Send test email</>}
                  </button>
                  {dirty > 0 && (
                    <span className="text-[11px] text-neutral-500">
                      Save first — the test uses the saved settings, not what&apos;s typed above.
                    </span>
                  )}
                </div>
                {testResult && (
                  <div
                    className={`mt-3 text-xs flex items-start gap-2 ${
                      testResult.ok ? "text-success" : "text-danger"
                    }`}
                  >
                    {testResult.ok
                      ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-px" />
                      : <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />}
                    <span className="break-words">{testResult.detail}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="card border-line/60 bg-white/[0.01]">
        <div className="text-sm font-medium flex items-center gap-2 mb-2">
          <Lock className="h-4 w-4 text-neutral-500" /> What can&apos;t be edited here
        </div>
        <ul className="text-xs text-neutral-400 space-y-1.5 list-disc ml-4">
          <li>
            <b>Database credentials</b> (<code>POCKETBASE_ADMIN_*</code>, <code>DB_BACKEND</code>) —
            they&apos;re how the app reaches this table, so storing them in it is circular.
          </li>
          <li>
            <b><code>SESSION_SECRET</code></b> — it authenticates the very cookie that
            authorises this page.
          </li>
          <li>
            <b><code>NEXT_PUBLIC_*</code></b> — Next.js compiles these into the browser
            bundle at build time. No database value can change a string that is already
            inside the JavaScript your users downloaded; those need a redeploy by design.
          </li>
        </ul>
      </div>
    </div>
  );
}

function SourceBadge({ source, envOnly }: { source: Item["source"]; envOnly: boolean }) {
  if (envOnly) {
    return <span className="pill pill-muted"><Lock className="h-2.5 w-2.5" /> environment only</span>;
  }
  if (source === "database") {
    return <span className="pill pill-success"><Database className="h-2.5 w-2.5" /> live</span>;
  }
  if (source === "environment") {
    return <span className="pill pill-info">from environment</span>;
  }
  return <span className="pill pill-warn">not set</span>;
}
