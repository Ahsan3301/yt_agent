"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  Gift, Copy, Check, Loader2, Users, Clock, CheckCircle2,
  AlertTriangle, Share2,
} from "lucide-react";

/**
 * Referrals — invite friends, earn free time.
 *
 * Flow: /r/<code> sets a 30-day yven_ref cookie → attributed on
 * /api/auth/register → flipped to "joined" when the referred user is
 * APPROVED → grantEarnedRewards extends the referrer's plan_expires_at.
 *
 * This page previously drew a progress ring and, on completion, told
 * the user to "ask an operator to upgrade you" — the unlock granted
 * nothing. Everything shown here is now backed by a real entitlement:
 * `rewards` comes from the referral_rewards ledger and `plan` is the
 * user's actual current plan and expiry.
 *
 * Tier definitions come from the API rather than being hardcoded here,
 * so changing the offer does not need a frontend edit.
 */

type Tier = { at: number; days: number; label: string; earned: boolean; granted: boolean };
type Reward = { tier: number; days_granted: number; granted_at: number; expires_after: number; note: string };

type Stats = {
  code: string;
  share_url: string;
  joined_count: number;
  signed_up_count: number;
  signups: Array<{ email: string; status: string; created_at: number; joined_at?: number }>;
  tiers: Tier[];
  next_tier: { at: number; days: number; label: string; remaining: number } | null;
  rewards: Reward[];
  total_days_granted: number;
  plan: { id: string; expires_at: number };
};

const fmt = (t?: number) =>
  t ? new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";

export default function ReferralsPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/referrals/me", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (r.ok) setS(j); else setErr(j.error || `HTTP ${r.status}`);
      } catch (e) { setErr(String(e)); }
    })();
  }, []);

  const copy = async () => {
    if (!s) return;
    try {
      await navigator.clipboard.writeText(s.share_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
  };

  if (err) {
    return (
      <div className="space-y-4">
        <PageHeader title="Referrals" subtitle="Invite friends, earn free time." />
        <div className="card text-sm text-danger flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> {err}
        </div>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="space-y-4">
        <PageHeader title="Referrals" subtitle="Invite friends, earn free time." />
        <div className="card flex items-center gap-2 text-sm text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  const joined = s.joined_count || 0;
  const top = s.tiers?.length ? s.tiers[s.tiers.length - 1].at : 10;
  const pct = Math.min(100, Math.round((joined / top) * 100));
  const planActive = s.plan?.expires_at > Math.floor(Date.now() / 1000);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Referrals"
        subtitle="Invite people who'll actually use it. When they're approved, you get free time on your plan."
      />

      {/* ── Reward state ─────────────────────────────────────────── */}
      {s.total_days_granted > 0 && (
        <div className="card border-success/25 bg-success/[0.04]">
          <div className="flex items-start gap-3">
            <Gift className="h-5 w-5 text-success shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-white">
                {s.total_days_granted} free days earned
              </div>
              <p className="text-xs text-neutral-400 mt-1">
                {planActive
                  ? <>Your <b className="text-neutral-200">{s.plan.id}</b> plan is active until <b className="text-neutral-200">{fmt(s.plan.expires_at)}</b>.</>
                  : <>Your reward period has ended. Refer more people to extend it again.</>}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Progress across both tiers ───────────────────────────── */}
      <div className="card space-y-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div className="text-sm font-medium">
            {joined} approved referral{joined === 1 ? "" : "s"}
          </div>
          {s.next_tier && (
            <div className="text-xs text-neutral-400">
              {s.next_tier.remaining} more for <b className="text-accent">{s.next_tier.label}</b>
            </div>
          )}
        </div>

        {/* A single bar with both milestones marked reads better than
            two rings — the second tier is a continuation of the first,
            not a separate goal. */}
        <div className="relative">
          <div className="progress-track h-2">
            <div className="progress-fill h-2 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="relative mt-2 h-5">
            {s.tiers?.map((t) => (
              <div
                key={t.at}
                className="absolute -translate-x-1/2 text-[10px] whitespace-nowrap"
                style={{ left: `${Math.min(100, (t.at / top) * 100)}%` }}
              >
                <span className={t.earned ? "text-success" : "text-neutral-600"}>
                  {t.earned ? "✓ " : ""}{t.at} · {t.days}d
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
          {s.tiers?.map((t) => (
            <div
              key={t.at}
              className={`rounded-xl border p-3 ${
                t.granted ? "border-success/30 bg-success/[0.05]"
                : t.earned ? "border-warn/30 bg-warn/[0.05]"
                : "border-line bg-white/[0.02]"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                {t.granted
                  ? <CheckCircle2 className="h-4 w-4 text-success" />
                  : <Users className="h-4 w-4 text-neutral-500" />}
                {t.label}
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                {t.granted ? `Granted — ${t.at} approved referrals`
                  : t.earned
                    // Earned but no ledger row: the grant did not land.
                    // Say so rather than showing it as complete.
                    ? `Earned but not yet applied — contact support`
                    : `${t.at} approved referrals`}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Share link ───────────────────────────────────────────── */}
      <div className="card space-y-2">
        <div className="text-sm font-medium flex items-center gap-2">
          <Share2 className="h-4 w-4 text-accent" /> Your invite link
        </div>
        <div className="flex gap-2">
          <input readOnly value={s.share_url} onFocus={(e) => e.currentTarget.select()} className="input flex-1 text-xs" />
          <button onClick={copy} className="btn btn-ghost h-9 text-xs shrink-0">
            {copied ? <><Check className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
          </button>
        </div>
        <p className="text-[11px] text-neutral-500">
          A referral counts once that person is <b>approved</b> — not when they click, and not
          when they sign up. That keeps the reward tied to real users.
        </p>
      </div>

      {/* ── Who you've referred ──────────────────────────────────── */}
      <div className="card space-y-3">
        <div className="text-sm font-medium">People you&apos;ve referred</div>
        {s.signups?.length ? (
          <div className="space-y-1.5">
            {s.signups.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-line/50 last:border-0">
                <span className="text-neutral-300 truncate">{r.email}</span>
                <span className={`pill ${r.status === "joined" ? "pill-success" : "pill-muted"} shrink-0`}>
                  {r.status === "joined" ? `Approved · ${fmt(r.joined_at)}` : "Signed up"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          // No padded placeholder rows. The old page rendered five
          // "Waiting…" slots, which made an empty list look like
          // pending activity that did not exist.
          <p className="text-xs text-neutral-500">
            Nobody yet. Share your link above — you&apos;ll see people here as they sign up.
          </p>
        )}
        {s.signed_up_count > joined && (
          <p className="text-[11px] text-neutral-500 flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            {s.signed_up_count - joined} signed up and waiting on approval — they&apos;ll count once approved.
          </p>
        )}
      </div>

      {/* ── Reward history ───────────────────────────────────────── */}
      {s.rewards?.length > 0 && (
        <div className="card space-y-2">
          <div className="text-sm font-medium">Rewards granted</div>
          {s.rewards.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-line/50 last:border-0">
              <span className="text-neutral-300">{r.note}</span>
              <span className="text-neutral-500 shrink-0">
                {fmt(r.granted_at)} → expires {fmt(r.expires_after)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
