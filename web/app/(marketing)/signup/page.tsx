"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Loader2, ArrowLeft, ArrowRight, CheckCircle2, KeyRound, Mail,
  Play, Sparkles, UserPlus, Zap, Layers, Rocket,
} from "lucide-react";

/**
 * Signup — two-panel like login. Left = brand + benefit list, right =
 * form. Success state shows a full-panel "pending approval" screen.
 */
export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [kaggleUser, setKaggleUser] = useState("");
  const [kaggleKey, setKaggleKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("passwords don't match"); return; }
    if (password.length < 10) { setError("password must be at least 10 characters"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email, password,
          kaggle_username: kaggleUser.trim(),
          kaggle_key: kaggleKey.trim(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setDone(true);
      else setError(j.error || `HTTP ${r.status}`);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="blob top-[-8rem] left-[-8rem] h-[500px] w-[500px]"
               style={{ background: "radial-gradient(circle, rgba(16,185,129,0.28) 0%, transparent 70%)" }} />
          <div className="blob bottom-[-8rem] right-[-8rem] h-[500px] w-[500px] animate-[blob_28s_ease-in-out_infinite]"
               style={{ background: "radial-gradient(circle, rgba(139,92,246,0.22) 0%, transparent 70%)" }} />
          <div className="absolute inset-0 dot-grid" />
        </div>
        <div className="w-full max-w-md text-center space-y-6 animate-[fadeUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]">
          <div className="relative mx-auto w-fit">
            <div className="absolute inset-0 rounded-full bg-emerald-500/30 blur-2xl animate-pulse-slow" />
            <div className="relative h-16 w-16 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-2xl shadow-emerald-500/30">
              <CheckCircle2 className="h-8 w-8 text-white" strokeWidth={2.5} />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">You're on the list</h2>
            <p className="text-sm text-neutral-400 max-w-sm mx-auto">
              An operator will review your signup shortly. You'll be able to sign in once your account is approved.
            </p>
          </div>
          <Link href="/" className="btn btn-ghost inline-flex">
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid md:grid-cols-[1.05fr_1fr] relative overflow-hidden">
      {/* Ambient blobs */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="blob top-[-8rem] left-[-8rem] h-[500px] w-[500px]"
             style={{ background: "radial-gradient(circle, rgba(139,92,246,0.28) 0%, transparent 70%)" }} />
        <div className="blob bottom-[-8rem] right-[-8rem] h-[500px] w-[500px] animate-[blob_28s_ease-in-out_infinite]"
             style={{ background: "radial-gradient(circle, rgba(249,115,22,0.22) 0%, transparent 70%)" }} />
        <div className="absolute inset-0 dot-grid" />
      </div>

      {/* Left panel */}
      <aside className="hidden md:flex flex-col justify-between p-12 relative border-r border-line/40 bg-bg-1/40 backdrop-blur">
        <Link href="/" className="flex items-center gap-2.5 group w-fit">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow group-hover:scale-105 transition-transform">
            <Play className="h-4 w-4 text-white fill-white" strokeWidth={0} />
          </div>
          <span className="font-semibold tracking-tight">Shortsmith</span>
        </Link>

        <div className="space-y-8 max-w-md">
          <div className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-bg-1/70 px-3 py-1 text-xs text-neutral-300">
            <Sparkles className="h-3 w-3 text-accent" />
            Access is review-gated
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight">
            Start shipping <span className="text-gradient-static">Shorts on autopilot.</span>
          </h1>
          <div className="space-y-4">
            <BenefitRow icon={Zap}    title="One click to publish" body="Topic → script → voiceover → video → upload." />
            <BenefitRow icon={Layers} title="Multi-channel"        body="Each channel gets its own tone, voice, and schedule." />
            <BenefitRow icon={Rocket} title="Runs on cron"         body="Daily quotas, timezone-aware. Set once, publish forever." />
          </div>
        </div>

        <div className="text-xs text-neutral-500 flex items-center justify-between">
          <span>© {new Date().getUTCFullYear()} Shortsmith</span>
          <Link href="/login" className="hover:text-neutral-300 transition">Already have an account? →</Link>
        </div>
      </aside>

      {/* Right panel — form */}
      <main className="flex flex-col items-center justify-center p-6 md:p-12 relative">
        <Link href="/" className="md:hidden absolute top-6 left-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow">
            <Play className="h-3.5 w-3.5 text-white fill-white" strokeWidth={0} />
          </div>
          <span className="font-semibold tracking-tight text-sm">Shortsmith</span>
        </Link>

        <div className="w-full max-w-sm animate-[fadeUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]">
          <div className="space-y-2 mb-6">
            <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-accent" /> Request access
            </h2>
            <p className="text-sm text-neutral-400">
              An operator reviews new signups before you can log in.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label flex items-center gap-1"><Mail className="h-3 w-3" /> Email</label>
              <input type="email" required autoFocus autoComplete="email"
                     placeholder="you@example.com"
                     className="input h-11"
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="label flex items-center gap-1"><KeyRound className="h-3 w-3" /> Password (10+ chars)</label>
              <input type="password" required autoComplete="new-password"
                     placeholder="••••••••••••"
                     className="input h-11 font-mono"
                     value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div>
              <label className="label">Confirm password</label>
              <input type="password" required autoComplete="new-password"
                     placeholder="••••••••••••"
                     className="input h-11 font-mono"
                     value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>

            <details className="group">
              <summary className="cursor-pointer text-xs text-neutral-400 hover:text-neutral-200 flex items-center gap-1 select-none">
                <span className="inline-block w-3 h-3 text-center leading-3 transition-transform group-open:rotate-90">›</span>
                Optional — bring your own Kaggle worker
              </summary>
              <div className="mt-3 space-y-3 pl-4 border-l border-line">
                <div>
                  <label className="label">Kaggle username</label>
                  <input type="text" className="input h-10" placeholder="yourname"
                         value={kaggleUser} onChange={(e) => setKaggleUser(e.target.value)} />
                </div>
                <div>
                  <label className="label">Kaggle API key</label>
                  <input type="password" className="input h-10 font-mono" placeholder="from kaggle.com/account"
                         value={kaggleKey} onChange={(e) => setKaggleKey(e.target.value)} />
                </div>
              </div>
            </details>

            {error && (
              <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/[0.06] rounded-lg px-3.5 py-2.5 animate-[fadeIn_0.2s_ease-out]">
                {error}
              </div>
            )}

            <button type="submit" disabled={busy || !email || !password}
                    className="btn btn-primary w-full h-11 text-sm mt-2 group">
              {busy
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating account…</>
                : <>Create account <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" /></>}
            </button>

            <div className="flex items-center justify-between text-xs text-neutral-500 pt-3">
              <Link href="/" className="hover:text-neutral-300 transition">← Home</Link>
              <Link href="/login" className="hover:text-neutral-300 transition">Have an account? Sign in →</Link>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

function BenefitRow({
  icon: Icon, title, body,
}: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-accent/25 to-accent-glow/15 border border-accent/30 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-accent" />
      </div>
      <div>
        <div className="font-medium text-[15px]">{title}</div>
        <div className="text-sm text-neutral-400">{body}</div>
      </div>
    </div>
  );
}
