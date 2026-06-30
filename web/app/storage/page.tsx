"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  HardDrive, Plus, Trash2, Edit3, Loader2, Save, X as XIcon,
  CheckCircle2, AlertCircle, ArrowUpCircle, ArrowDownCircle, Wand2,
  Cloud, Server, Database, Globe,
} from "lucide-react";
import { useToast } from "@/components/Toast";

/**
 * Storage providers management page.
 *
 * Lets the user connect MinIO / R2 / AWS S3 / Wasabi / B2 / Hostinger
 * SFTP destinations and pick which one is primary (videos go here)
 * and which one (optional) is mirror (best-effort copy for backup).
 */

type ProviderKind = "minio" | "r2" | "aws_s3" | "wasabi" | "b2" | "hostinger_sftp";

type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  endpoint?: string;
  bucket?: string;
  region?: string;
  public_base?: string;
  path_style?: boolean;
  host?: string;
  port?: number;
  user?: string;
  base_dir?: string;
  is_primary?: boolean;
  is_mirror?: boolean;
  enabled?: boolean;
  last_health_ok?: boolean | null;
  last_health_check?: number | null;
  access_key_id_preview?: string;
  secret_set?: boolean;
  password_set?: boolean;
  extras?: Record<string, unknown>;
};

const KIND_META: Record<ProviderKind, { label: string; icon: typeof Cloud; hint: string }> = {
  minio:          { label: "MinIO (self-hosted)",      icon: Server,   hint: "Default for Coolify deploys. Free, unlimited disk." },
  r2:             { label: "Cloudflare R2",            icon: Cloud,    hint: "S3-compatible. 10 GB free, no egress fees." },
  aws_s3:         { label: "AWS S3",                   icon: Cloud,    hint: "The original. Pay per GB + per request." },
  wasabi:         { label: "Wasabi",                   icon: Cloud,    hint: "Cheap hot storage, no egress fees." },
  b2:             { label: "Backblaze B2",             icon: Database, hint: "Even cheaper, slightly slower." },
  hostinger_sftp: { label: "Hostinger SFTP",           icon: Globe,    hint: "Use existing Hostinger hosting as cold storage." },
};

export default function StoragePage() {
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/storage/providers", { cache: "no-store" });
      const d = await r.json();
      setProviders(Array.isArray(d) ? d : []);
    } catch (e) {
      toast.error("Couldn't load providers", String(e));
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const save = async (p: Partial<Provider> & { secret_access_key?: string; password?: string; access_key_id?: string }) => {
    try {
      const r = await fetch("/api/storage/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error("Save failed", d.error || `HTTP ${r.status}`);
        return false;
      }
      toast.success("Saved", `"${d.name || p.name}" updated.`);
      await refresh();
      return true;
    } catch (e) {
      toast.error("Save failed", String(e));
      return false;
    }
  };

  const remove = async (p: Provider) => {
    if (!confirm(`Delete provider "${p.name}"? Existing videos already on this provider won't be deleted from the remote.`)) return;
    try {
      const r = await fetch(`/api/storage/providers?id=${encodeURIComponent(p.id)}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) {
        toast.error("Delete failed", d.error || `HTTP ${r.status}`);
        return;
      }
      toast.info("Deleted", `"${p.name}" removed.`);
      await refresh();
    } catch (e) {
      toast.error("Delete failed", String(e));
    }
  };

  const test = async (p: Provider) => {
    setTesting(p.id);
    try {
      const r = await fetch(`/api/storage/providers/${encodeURIComponent(p.id)}/test`, { method: "POST" });
      const d = await r.json();
      if (d.ok) toast.success("Connection OK", d.message || "");
      else toast.error("Connection failed", d.message || d.error || "");
      await refresh();
    } catch (e) {
      toast.error("Test failed", String(e));
    }
    setTesting(null);
  };

  const promote = async (p: Provider, role: "primary" | "mirror") => {
    try {
      const r = await fetch(`/api/storage/providers/${encodeURIComponent(p.id)}/promote?role=${role}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        toast.error("Promote failed", d.error || `HTTP ${r.status}`);
        return;
      }
      toast.success(`Set as ${role}`, p.name);
      await refresh();
    } catch (e) {
      toast.error("Promote failed", String(e));
    }
  };

  const clearMirror = async (p: Provider) => {
    try {
      const r = await fetch(`/api/storage/providers/${encodeURIComponent(p.id)}/promote?role=mirror`, { method: "DELETE" });
      if (!r.ok) {
        toast.error("Clear failed", `HTTP ${r.status}`);
        return;
      }
      toast.info("Mirror cleared", p.name);
      await refresh();
    } catch (e) {
      toast.error("Clear failed", String(e));
    }
  };

  const hasPrimary = providers.some((p) => p.is_primary && p.enabled !== false);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <HardDrive className="h-6 w-6 text-accent" />
            Storage providers
          </h1>
          <p className="text-sm text-neutral-400 max-w-2xl mt-1">
            Where finished videos get uploaded. Pick a <b>primary</b>
            {" "}(required) — that's where every render goes. Optionally
            add a <b>mirror</b> so videos get copied to a second
            destination for backup. Mirror failures don&apos;t fail
            renders.
          </p>
        </div>
        {!showNew && !editing && (
          <button onClick={() => setShowNew(true)} className="btn btn-primary h-9 text-sm">
            <Plus className="h-4 w-4" /> Add provider
          </button>
        )}
      </div>

      {!loading && !hasPrimary && providers.length > 0 && (
        <div className="card border-amber-500/30 bg-amber-500/5 text-sm">
          <AlertCircle className="h-4 w-4 inline text-amber-300 mr-2" />
          No primary provider selected. Renders will fall back to env-var
          config if any, otherwise fail. Promote one of the providers
          below to <b>primary</b>.
        </div>
      )}

      {(showNew || editing) && (
        <ProviderForm
          initial={editing}
          onCancel={() => { setShowNew(false); setEditing(null); }}
          onSave={async (p) => {
            const ok = await save(p);
            if (ok) {
              setShowNew(false);
              setEditing(null);
            }
          }}
        />
      )}

      {loading && providers.length === 0 ? (
        <div className="card text-center text-neutral-500 py-10">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
          Loading providers…
        </div>
      ) : providers.length === 0 ? (
        <div className="card text-center text-sm text-neutral-500 py-10">
          No storage providers configured. Click <b>Add provider</b> to
          connect MinIO, R2, AWS S3, or another destination.
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              testing={testing === p.id}
              onEdit={() => setEditing(p)}
              onDelete={() => remove(p)}
              onTest={() => test(p)}
              onPromote={(role) => promote(p, role)}
              onClearMirror={() => clearMirror(p)}
            />
          ))}
        </div>
      )}

      <div className="card text-xs text-neutral-500 space-y-1">
        <div className="font-medium text-neutral-300">How storage providers work</div>
        <p>
          <b>Primary:</b> every render writes here. Must be reachable or
          the render fails (with retries + verification baked in).
        </p>
        <p>
          <b>Mirror:</b> every render also tries to write here. Best-effort
          — failures get logged but don&apos;t fail the render. Good for
          offsite backup (primary on MinIO, mirror to Backblaze, etc.).
        </p>
        <p>
          Secrets are encrypted at rest with{" "}
          <code>STORAGE_PROVIDERS_ENC_KEY</code>. The dashboard only ever
          shows masked previews.
        </p>
      </div>
    </div>
  );
}

function ProviderCard({
  provider: p, testing, onEdit, onDelete, onTest, onPromote, onClearMirror,
}: {
  provider: Provider;
  testing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onPromote: (role: "primary" | "mirror") => void;
  onClearMirror: () => void;
}) {
  const meta = KIND_META[p.kind];
  const Icon = meta?.icon || HardDrive;

  const target = p.kind === "hostinger_sftp"
    ? `${p.user || "?"}@${p.host || "?"}:${p.base_dir || "/"}`
    : `${p.endpoint || "?"} / ${p.bucket || "?"}`;

  return (
    <div className={clsx(
      "card flex items-center gap-3 flex-wrap",
      p.enabled === false && "opacity-50",
    )}>
      <div className="h-9 w-9 rounded-md bg-bg-2 border border-line flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-semibold">{p.name}</div>
          <code className="text-xs text-neutral-500">{p.id}</code>
          {p.is_primary && <span className="pill pill-good text-[10px]">PRIMARY</span>}
          {p.is_mirror && <span className="pill pill-info text-[10px]">MIRROR</span>}
          {p.enabled === false && <span className="pill pill-muted text-[10px]">disabled</span>}
          {p.last_health_ok === true && (
            <span className="pill pill-good text-[10px]">
              <CheckCircle2 className="h-3 w-3" /> healthy
            </span>
          )}
          {p.last_health_ok === false && (
            <span className="pill pill-bad text-[10px]">
              <AlertCircle className="h-3 w-3" /> unhealthy
            </span>
          )}
        </div>
        <div className="text-xs text-neutral-400 mt-0.5">
          {meta?.label} · <code className="text-neutral-300">{target}</code>
        </div>
        {p.access_key_id_preview && (
          <div className="text-[10px] text-neutral-500 mt-0.5">
            access key: <code>{p.access_key_id_preview}</code>
            {p.secret_set ? " · secret stored" : " · NO SECRET"}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button onClick={onTest} disabled={testing} className="btn btn-ghost h-7 text-xs">
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
          Test
        </button>
        {!p.is_primary && (
          <button onClick={() => onPromote("primary")} className="btn btn-ghost h-7 text-xs">
            <ArrowUpCircle className="h-3 w-3" /> Make primary
          </button>
        )}
        {!p.is_mirror && !p.is_primary && (
          <button onClick={() => onPromote("mirror")} className="btn btn-ghost h-7 text-xs">
            <ArrowDownCircle className="h-3 w-3" /> Make mirror
          </button>
        )}
        {p.is_mirror && (
          <button onClick={onClearMirror} className="btn btn-ghost h-7 text-xs text-neutral-400">
            Clear mirror
          </button>
        )}
        <button onClick={onEdit} className="btn btn-ghost h-7 text-xs">
          <Edit3 className="h-3 w-3" /> Edit
        </button>
        <button onClick={onDelete} className="btn btn-ghost h-7 text-xs text-neutral-400 hover:text-red-300">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function ProviderForm({
  initial, onSave, onCancel,
}: {
  initial: Provider | null;
  onSave: (
    p: Partial<Provider> & { secret_access_key?: string; password?: string; access_key_id?: string },
  ) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [kind, setKind] = useState<ProviderKind>(initial?.kind || "minio");
  const [endpoint, setEndpoint] = useState(initial?.endpoint || "");
  const [bucket, setBucket] = useState(initial?.bucket || "");
  const [region, setRegion] = useState(initial?.region || "auto");
  const [publicBase, setPublicBase] = useState(initial?.public_base || "");
  const [pathStyle, setPathStyle] = useState(initial?.path_style !== false);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [host, setHost] = useState(initial?.host || "");
  const [port, setPort] = useState(initial?.port || 22);
  const [user, setUser] = useState(initial?.user || "");
  const [password, setPassword] = useState("");
  const [baseDir, setBaseDir] = useState(initial?.base_dir || "");
  const [accountId, setAccountId] = useState(
    ((initial?.extras as Record<string, string>) || {}).account_id || "",
  );
  const [enabled, setEnabled] = useState(initial?.enabled !== false);

  const isSftp = kind === "hostinger_sftp";
  const isR2 = kind === "r2";
  const meta = KIND_META[kind];

  const submit = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id,
      name: name.trim(),
      kind,
      endpoint: endpoint.trim() || undefined,
      bucket: bucket.trim() || undefined,
      region: region.trim() || "auto",
      public_base: publicBase.trim() || undefined,
      path_style: pathStyle,
      access_key_id: accessKeyId.trim() || undefined,
      secret_access_key: secretAccessKey.trim() || undefined,
      host: host.trim() || undefined,
      port: Number(port) || 22,
      user: user.trim() || undefined,
      password: password.trim() || undefined,
      base_dir: baseDir.trim() || undefined,
      enabled,
      extras: isR2 ? { account_id: accountId.trim() } : undefined,
    });
  };

  return (
    <div className="card space-y-4 border-accent/30">
      <div className="font-semibold flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-accent" />
        {initial ? `Edit "${initial.name}"` : "Add storage provider"}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="label">Display name</label>
          <input
            className="input w-full"
            placeholder="e.g. Coolify MinIO"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!initial}
          />
        </div>
        <div>
          <label className="label">Provider type</label>
          <select
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as ProviderKind)}
            disabled={!!initial}
          >
            {(Object.keys(KIND_META) as ProviderKind[]).map((k) => (
              <option key={k} value={k}>{KIND_META[k].label}</option>
            ))}
          </select>
          <div className="text-[10px] text-neutral-500 mt-1">{meta.hint}</div>
        </div>
      </div>

      {/* S3-like fields */}
      {!isSftp && (
        <>
          {isR2 && (
            <div>
              <label className="label">Cloudflare account ID</label>
              <input
                className="input w-full"
                placeholder="32-hex-character account ID from dash.cloudflare.com"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
              <div className="text-[10px] text-neutral-500 mt-1">
                The endpoint will be derived as
                {" "}<code>https://&lt;account&gt;.r2.cloudflarestorage.com</code>.
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Endpoint URL {isR2 ? "(optional — derived from account)" : ""}</label>
              <input
                className="input w-full"
                placeholder={
                  kind === "minio"  ? "https://your-domain.com/s3" :
                  kind === "aws_s3" ? "https://s3.us-east-1.amazonaws.com (or leave blank)" :
                  kind === "wasabi" ? "https://s3.us-east-1.wasabisys.com (or leave blank)" :
                  kind === "b2"     ? "https://s3.us-east-005.backblazeb2.com (or leave blank)" :
                  "https://...r2.cloudflarestorage.com"
                }
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Bucket</label>
              <input
                className="input w-full"
                placeholder="yt-agent-videos"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Region</label>
              <input
                className="input w-full"
                placeholder={kind === "r2" ? "auto" : "us-east-1"}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Public URL prefix (where videos are served)</label>
              <input
                className="input w-full"
                placeholder="https://your-domain.com/s3/yt-agent-videos"
                value={publicBase}
                onChange={(e) => setPublicBase(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">
                Access key ID {initial ? "(leave blank to keep existing)" : ""}
              </label>
              <input
                className="input w-full"
                placeholder={initial?.access_key_id_preview || "AKIA..."}
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
              />
            </div>
            <div>
              <label className="label">
                Secret access key {initial?.secret_set ? "(leave blank to keep existing)" : ""}
              </label>
              <input
                type="password"
                className="input w-full"
                placeholder="••••••••••••"
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox" className="accent-accent"
              checked={pathStyle}
              onChange={(e) => setPathStyle(e.target.checked)}
            />
            Path-style addressing
            <span className="text-xs text-neutral-500">
              (recommended ON for MinIO + R2 with custom domain; OFF for vanilla AWS)
            </span>
          </label>
        </>
      )}

      {/* SFTP fields */}
      {isSftp && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="label">SFTP host</label>
              <input
                className="input w-full"
                placeholder="files.your-hostinger.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Port</label>
              <input
                type="number"
                className="input w-full"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">User</label>
              <input
                className="input w-full"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
            <div>
              <label className="label">
                Password {initial?.password_set ? "(leave blank to keep existing)" : ""}
              </label>
              <input
                type="password"
                className="input w-full"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Remote base directory</label>
              <input
                className="input w-full"
                placeholder="/public_html/yt-agent/videos"
                value={baseDir}
                onChange={(e) => setBaseDir(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Public URL prefix</label>
              <input
                className="input w-full"
                placeholder="https://your-hostinger-site.com/yt-agent/videos"
                value={publicBase}
                onChange={(e) => setPublicBase(e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox" className="accent-accent"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Provider enabled
        <span className="text-xs text-neutral-500">
          (uncheck to skip without deleting)
        </span>
      </label>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
        <button onClick={onCancel} className="btn btn-ghost h-8 text-xs">
          <XIcon className="h-3 w-3" /> Cancel
        </button>
        <button onClick={submit} disabled={!name.trim()} className="btn btn-primary h-8 text-xs">
          <Save className="h-3 w-3" /> {initial ? "Save changes" : "Add provider"}
        </button>
      </div>
    </div>
  );
}
