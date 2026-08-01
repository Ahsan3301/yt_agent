"use client";

import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Sparkles, Copy, Check } from "lucide-react";

/**
 * Referrals — 5-friend viral trial unlock.
 *
 * The real backend (persistent referral codes, join tracking,
 * plan-flip on threshold, notification pipeline) is not built yet.
 * Ships with a clear "Coming soon" banner + a working preview of
 * the interaction so users understand the model. When the backend
 * lands, flip PREVIEW_MODE and wire /api/referrals/* endpoints.
 */
const PREVIEW_MODE = true;

const SAMPLE_LINK = "yven.ai/r/preview-abc123";

const SAMPLE_FRIENDS: Array<{ initials: string; email: string; status: "joined" | "pending" }> = [
  { initials: "JD", email: "james@creator.com",  status: "joined"  },
  { initials: "AL", email: "amy@studio.co",      status: "joined"  },
  { initials: "RK", email: "ravi@tech.io",       status: "joined"  },
  { initials: "?",  email: "Waiting…",           status: "pending" },
  { initials: "?",  email: "Waiting…",           status: "pending" },
];

export default function ReferralsPage() {
  const [copied, setCopied] = useState(false);
  const joined = SAMPLE_FRIENDS.filter((f) => f.status === "joined").length;
  const pct = (joined / 5) * 100;
  const circumference = 2 * Math.PI * 90;
  const offset = circumference * (1 - joined / 5);

  const copy = () => {
    navigator.clipboard.writeText(SAMPLE_LINK).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <PageHeader
        eyebrow="Growth"
        title="Unlock your trial"
        subtitle="Share Yven with 5 creator friends. When they sign up, your trial activates instantly."
      />

      {PREVIEW_MODE && (
        <div className="rounded-2xl border border-warn/25 bg-warn/[0.05] px-5 py-4 text-sm text-amber-200 flex items-start gap-3">
          <Sparkles className="h-4 w-4 mt-0.5 shrink-0 text-warn" />
          <div>
            <div className="font-semibold text-amber-100">Preview mode — coming soon</div>
            <div className="text-xs text-amber-200/80 mt-0.5">
              Referral tracking, unique invite links, and automatic trial-unlock are being wired up.
              The interactions on this page are a preview of the real flow.
            </div>
          </div>
        </div>
      )}

      <div className="card p-11 text-center relative overflow-hidden">
        <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-warn/30 to-transparent" />

        {/* Progress ring */}
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
            <div className="text-5xl font-extrabold bg-gradient-to-br from-warn to-accent-glow bg-clip-text text-transparent">{joined}/5</div>
            <div className="text-[10px] text-neutral-500 uppercase tracking-[0.1em] mt-1">Friends joined ({Math.round(pct)}%)</div>
          </div>
        </div>

        <div className="flex gap-3 mb-9 max-w-md mx-auto">
          <input value={SAMPLE_LINK} readOnly
                 className="input h-12 flex-1 focus:border-warn" />
          <button onClick={copy}
                  className="btn btn-primary h-12 px-6 text-sm font-bold shrink-0">
            {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
          </button>
        </div>

        <div className="text-left max-w-md mx-auto">
          <h3 className="text-[10px] uppercase tracking-[0.1em] text-neutral-500 mb-4 font-bold">Your referrals</h3>
          {SAMPLE_FRIENDS.map((f, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5 bg-white/[0.015] border border-white/6 rounded-2xl mb-2 hover:border-accent/10 transition">
              <div className="flex items-center gap-3">
                <div className={
                  "w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 " +
                  (f.status === "joined"
                    ? "bg-gradient-to-br from-accent to-accent-glow text-white shadow-[0_0_12px_rgba(167,139,250,0.2)]"
                    : "bg-white/5 text-neutral-500")
                }>
                  {f.initials}
                </div>
                <span className={"text-sm " + (f.status === "joined" ? "text-neutral-300" : "text-neutral-500")}>
                  {f.email}
                </span>
              </div>
              <span className={
                "text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-full " +
                (f.status === "joined"
                  ? "bg-success/8 text-success shadow-[0_0_8px_rgba(34,197,94,0.1)]"
                  : "bg-warn/8 text-amber-300")
              }>
                {f.status === "joined" ? "Joined" : "Pending"}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-9 p-6 rounded-2xl border border-warn/15 bg-gradient-to-br from-warn/[0.06] to-accent-glow/[0.03] relative overflow-hidden max-w-md mx-auto">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-warn/40 to-transparent" />
          <h3 className="text-lg font-bold text-warn mb-2">You're {5 - joined} friends away</h3>
          <p className="text-neutral-400 text-sm mb-4">
            The average Yven user unlocks their trial in under 48 hours. Share in creator Discords, Twitter DMs, or Instagram close friends.
          </p>
          <button onClick={copy} className="btn btn-primary h-11 px-7 text-sm font-bold">
            Share Yven Now
          </button>
        </div>
      </div>

      <div className="card p-8">
        <h3 className="text-base font-bold mb-5">Analytics wall preview</h3>
        <div className="grid grid-cols-3 gap-4 mb-3">
          {[
            ["2.4M", "Avg Views / Month"],
            ["68%",  "Avg Retention"],
            ["$12K", "Est. Monthly Value"],
          ].map(([val, lab]) => (
            <div key={lab} className="p-5 bg-white/[0.01] rounded-2xl border border-white/6 relative overflow-hidden">
              <div className="blur-sm select-none">
                <div className="text-2xl font-extrabold bg-gradient-to-br from-white to-accent bg-clip-text text-transparent">{val}</div>
                <div className="text-[10px] text-neutral-500 mt-1.5 uppercase tracking-wider">{lab}</div>
              </div>
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-2xl text-xs text-warn font-semibold">
                🔒 Unlock at 5
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-neutral-500 text-center mt-3">Full analytics unlock when your trial activates.</p>
      </div>
    </div>
  );
}
