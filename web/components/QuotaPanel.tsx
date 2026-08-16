"use client";

import { useEffect, useState } from "react";

/**
 * Trial status, today's usage, and the way to ask for more.
 *
 * Reads /api/quota/status, which resolves limits the SAME way the guard
 * does — override then plan — so this panel cannot contradict the error
 * message a user just hit. Two resolutions of one question is how a
 * dashboard ends up confidently disagreeing with the product.
 *
 * `limit: null` is uncapped and renders as "Unlimited", never as 0. A 0
 * would read as "you may do nothing", which is the opposite of what it
 * means.
 *
 * The form asks for what they want, not what they are missing: someone
 * who needs a second channel should not have to work out that they
 * currently have one.
 */

type Status = {
  channels: { used: number; limit: number | null };
  videosToday: { used: number; limit: number | null };
  trial: { active: boolean; expiresAt: number; daysLeft: number; daysGranted: number };
  enforced: boolean;
};

type Req = {
  id: string; status: string;
  want_channels?: number; want_videos_per_day?: number; want_days?: number;
  granted_channels?: number; granted_videos_per_day?: number; granted_days?: number;
  note?: string;
};

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const uncapped = limit == null || limit <= 0;
  const pct = uncapped ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const full = !uncapped && used >= limit;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.14em] text-neutral-500">{label}</span>
        <span className={`text-sm tabular-nums ${full ? "text-amber-300" : "text-neutral-200"}`}>
          {used}{uncapped ? "" : ` / ${limit}`}
          {uncapped && <span className="text-neutral-500"> · unlimited</span>}
        </span>
      </div>
      {!uncapped && (
        <div className="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${full ? "bg-amber-400" : "bg-emerald-400"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function QuotaPanel() {
  const [s, setS] = useState<Status | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ch, setCh] = useState("");
  const [vd, setVd] = useState("");
  const [days, setDays] = useState("");
  const [why, setWhy] = useState("");

  const load = async () => {
    try {
      const [a, b] = await Promise.all([
        fetch("/api/quota/status").then((r) => r.json()),
        fetch("/api/quota/request").then((r) => r.json()),
      ]);
      if (a?.ok) setS(a as Status);
      if (b?.ok) setReqs(b.requests || []);
    } catch { /* panel is informational — never break the page */ }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/quota/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          want_channels: Number(ch) || 0,
          want_videos_per_day: Number(vd) || 0,
          want_days: Number(days) || 0,
          reason: why,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d?.error || "Could not send that."); return; }
      setMsg("Request sent — we'll review it shortly.");
      setCh(""); setVd(""); setDays(""); setWhy(""); setOpen(false);
      load();
    } catch {
      setErr("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!s) return null;

  const pending = reqs.filter((r) => r.status === "pending");

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Your allowance</h2>
          {s.trial.active ? (
            <p className="mt-1 text-xs text-emerald-300/90">
              Referral trial · {s.trial.daysLeft} day{s.trial.daysLeft === 1 ? "" : "s"} left
              {s.trial.daysGranted > 0 && (
                <span className="text-neutral-500"> · {s.trial.daysGranted} earned so far</span>
              )}
            </p>
          ) : (
            <p className="mt-1 text-xs text-neutral-500">
              Invite creators to earn free time — 5 approved referrals unlock 7 days.
            </p>
          )}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-white/15 text-neutral-300 hover:text-white hover:border-white/30 transition"
        >
          {open ? "Cancel" : "Request more"}
        </button>
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <Meter label="Channels" used={s.channels.used} limit={s.channels.limit} />
        <Meter label="Videos today" used={s.videosToday.used} limit={s.videosToday.limit} />
      </div>

      {!s.enforced && (
        // Say so rather than showing meters that do not bind. An
        // operator testing with enforcement off should not be misled
        // into thinking a cap is live.
        <p className="mt-4 text-[11px] text-neutral-600">
          Limits are not being enforced on this account yet.
        </p>
      )}

      {pending.length > 0 && (
        <p className="mt-4 text-xs text-amber-300/80">
          {pending.length} request{pending.length === 1 ? "" : "s"} awaiting review.
        </p>
      )}

      {open && (
        <form onSubmit={submit} className="mt-5 space-y-3 border-t border-white/10 pt-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label">Channels</label>
              <input type="number" min="0" className="input h-10" placeholder="e.g. 3"
                     value={ch} onChange={(e) => setCh(e.target.value)} />
            </div>
            <div>
              <label className="label">Videos / day</label>
              <input type="number" min="0" className="input h-10" placeholder="e.g. 5"
                     value={vd} onChange={(e) => setVd(e.target.value)} />
            </div>
            <div>
              <label className="label">Extra days</label>
              <input type="number" min="0" className="input h-10" placeholder="e.g. 14"
                     value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">What are you working on?</label>
            <textarea className="input min-h-[72px] py-2" placeholder="A sentence is plenty."
                      value={why} onChange={(e) => setWhy(e.target.value)} />
          </div>
          {err && <p className="text-sm text-red-300">{err}</p>}
          <button type="submit" disabled={busy}
                  className="px-5 py-2 rounded-full bg-white text-black text-sm font-semibold hover:bg-neutral-200 transition disabled:opacity-50">
            {busy ? "Sending…" : "Send request"}
          </button>
        </form>
      )}

      {msg && <p className="mt-4 text-sm text-emerald-300">{msg}</p>}
    </div>
  );
}
