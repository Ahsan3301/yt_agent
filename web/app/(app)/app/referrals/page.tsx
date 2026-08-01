"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Sparkles, Copy, Check, Loader2, ExternalLink } from "lucide-react";

/**
 * Referrals — 5-friend viral trial unlock.
 *
 * Fully live: pulls the caller's code + progress from
 * /api/referrals/me. Share links resolve through /r/<code> which sets
 * a 30-day yven_ref cookie → attributed on /api/auth/register →
 * flipped to "joined" by /api/admin/users/[id]/approve when the
 * referred user is approved. Once joined_count crosses 5 the
 * referrals row is stamped with unlocked_at.
 */

type Stats = {
  code: string;
  share_url: string;
  share_url_path: string;
  joined_count: number;
  signed_up_count: number;
  signups: Array<{ email: string; status: string; created_at: number; joined_at?: number }>;
  unlocked: boolean;
  unlocked_at?: number;
  threshold: number;
};

export default function ReferralsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/referrals/me");
        const j = await r.json().catch(() => ({}));
        if (r.ok) setStats(j);
        else setErr(j.error || `HTTP ${r.status}`);
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);

  const copy = () => {
    if (!stats) return;
    navigator.clipboard.writeText(stats.share_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (err) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <PageHeader eyebrow="Growth" title="Unlock your trial" />
        <div className="card text-sm text-red-300 border-red-500/30 bg-red-500/[0.04]">
          {err}
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <PageHeader eyebrow="Growth" title="Unlock your trial" />
        <div className="card text-center py-12 text-neutral-500">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Loading your referral link…
        </div>
      </div>
    );
  }

  const { joined_count, signed_up_count, signups, unlocked, threshold, share_url } = stats;
  const goal = Math.max(joined_count, 0);
  const remaining = Math.max(threshold - goal, 0);
  const pct = Math.min((goal / threshold) * 100, 100);
  const circumference = 2 * Math.PI * 90;
  const offset = circumference * (1 - Math.min(goal / threshold, 1));

  // Present real signups + pad with pending placeholder slots up to threshold
  // so the ring / list always show the goal state.
  const rows: Array<{ initials: string; label: string; status: string; placeholder?: true }> = [];
  for (const s of signups.slice(0, threshold)) {
    const parts = s.email.split("@")[0].split(/[._-]/).filter(Boolean);
    const initials = ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
    rows.push({ initials, label: s.email, status: s.status === "joined" ? "Joined" : "Signed up" });
  }
  while (rows.length < threshold) {
    rows.push({ initials: "?", label: "Waiting…", status: "Pending", placeholder: true });
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <PageHeader
        eyebrow="Growth"
        title={unlocked ? "Trial unlocked" : "Unlock your trial"}
        subtitle={
          unlocked
            ? `You hit ${threshold} joined friends — thanks for spreading Yven.`
            : `Share Yven with ${threshold} creator friends. When they sign up and get approved, your trial activates.`
        }
      />

      <div className="card p-11 text-center relative overflow-hidden">
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-warn/30 to-transparent" />

        <div className="relative w-52 h-52 mx-auto mb-9">
          <svg width="200" height="200" viewBox="0 0 200 200" style={{ transform: "rotate(-90deg)" }} className="drop-shadow-[0_0_10px_rgba(251,191,36,0.2)]">
            <defs>
              <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%"   stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#f0abfc" />
              </linearGradient>
            </defs>
            <circle cx="100" cy="100" r="90" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="10" />
            <circle cx="100" cy="100" r="90" fill="none" stroke="url(#progressGradient)" strokeWidth="10"
                    strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
                    style={{ transition: "stroke-dashoffset 1.5s ease" }} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-5xl font-extrabold bg-gradient-to-br from-warn to-accent-glow bg-clip-text text-transparent">{goal}/{threshold}</div>
            <div className="text-[10px] text-neutral-500 uppercase tracking-[0.1em] mt-1">
              Friends joined ({Math.round(pct)}%)
            </div>
          </div>
        </div>

        <div className="flex gap-3 mb-9 max-w-md mx-auto">
          <input value={share_url} readOnly
                 className="input h-12 flex-1 focus:border-warn text-xs md:text-sm" />
          <button onClick={copy}
                  className="btn btn-primary h-12 px-6 text-sm font-bold shrink-0">
            {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
          </button>
        </div>

        <div className="text-left max-w-md mx-auto">
          <h3 className="text-[10px] uppercase tracking-[0.1em] text-neutral-500 mb-4 font-bold flex items-center justify-between">
            <span>Your referrals</span>
            <span className="text-neutral-500 normal-case font-normal">
              {joined_count} joined · {signed_up_count} pending approval
            </span>
          </h3>
          {rows.map((f, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5 bg-white/[0.015] border border-white/6 rounded-2xl mb-2 hover:border-accent/10 transition">
              <div className="flex items-center gap-3">
                <div className={
                  "w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 " +
                  (f.status === "Joined"
                    ? "bg-gradient-to-br from-accent to-accent-glow text-white shadow-[0_0_12px_rgba(167,139,250,0.2)]"
                    : f.placeholder
                      ? "bg-white/5 text-neutral-500"
                      : "bg-gradient-to-br from-warn/60 to-accent-glow/60 text-white/90")
                }>
                  {f.initials}
                </div>
                <span className={"text-sm " + (f.status === "Joined" ? "text-neutral-300" : "text-neutral-500")}>
                  {f.label}
                </span>
              </div>
              <span className={
                "text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-full " +
                (f.status === "Joined"
                  ? "bg-success/8 text-success shadow-[0_0_8px_rgba(34,197,94,0.1)]"
                  : f.status === "Signed up"
                    ? "bg-info/8 text-cyan-300"
                    : "bg-warn/8 text-amber-300")
              }>
                {f.status}
              </span>
            </div>
          ))}
        </div>

        {!unlocked && (
          <div className="mt-9 p-6 rounded-2xl border border-warn/15 bg-gradient-to-br from-warn/[0.06] to-accent-glow/[0.03] relative overflow-hidden max-w-md mx-auto">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-warn/40 to-transparent" />
            <h3 className="text-lg font-bold text-warn mb-2">
              You're {remaining} friend{remaining === 1 ? "" : "s"} away
            </h3>
            <p className="text-neutral-400 text-sm mb-4">
              Share in creator Discords, Twitter DMs, or Instagram close friends.
              Attribution stays valid for 30 days after they click your link.
            </p>
            <button onClick={copy} className="btn btn-primary h-11 px-7 text-sm font-bold">
              Share Yven Now
            </button>
          </div>
        )}

        {unlocked && (
          <div className="mt-9 p-6 rounded-2xl border border-success/25 bg-success/[0.05] max-w-md mx-auto">
            <div className="flex items-start gap-3">
              <Sparkles className="h-5 w-5 mt-0.5 text-success shrink-0" />
              <div className="text-left">
                <div className="font-bold text-success mb-1">Trial unlocked</div>
                <div className="text-neutral-400 text-sm">
                  Full analytics + Pro features are unlocked on your plan.
                  Ask an operator to upgrade you to the referral-unlock plan
                  if you don't see them.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card p-8">
        <h3 className="text-base font-bold mb-3 flex items-center gap-2">
          How referrals work
          <ExternalLink className="h-3.5 w-3.5 text-neutral-500" />
        </h3>
        <ol className="space-y-2 text-sm text-neutral-400 list-decimal ml-4">
          <li>You share your link. Anyone visiting it gets a 30-day attribution cookie.</li>
          <li>They sign up. Their signup is attributed to you.</li>
          <li>An operator approves them (usually within 24h) — that flips them to "Joined".</li>
          <li>At {threshold} joined, your trial unlocks automatically.</li>
        </ol>
      </div>
    </div>
  );
}
