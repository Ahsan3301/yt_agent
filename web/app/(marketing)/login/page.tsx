"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Loader2, Mail, KeyRound, ArrowRight, Play, Sparkles } from "lucide-react";

/**
 * Login — dual-mode (email+password / legacy master password).
 * Two-panel layout: left = brand + trust markers, right = form.
 * Mobile collapses to single column with brand strip.
 */
export default function LoginPage() {
  const [mode, setMode] = useState<"v2" | "v1">("v2");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState("/");

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("next");
    if (p && p.startsWith("/") && !p.startsWith("//")) setNextPath(p);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === "v2" ? { email, password } : { password };
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        window.location.href = nextPath;
      } else {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`);
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const canSubmit = mode === "v2" ? (!!email && !!password) : !!password;

  return (
    <div className="min-h-screen grid md:grid-cols-[1.05fr_1fr] relative overflow-hidden">
      {/* Ambient blobs */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="blob top-[-8rem] left-[-8rem] h-[500px] w-[500px]"
             style={{ background: "radial-gradient(circle, rgba(139,92,246,0.28) 0%, transparent 70%)" }} />
        <div className="blob bottom-[-8rem] right-[-8rem] h-[500px] w-[500px] animate-[blob_28s_ease-in-out_infinite]"
             style={{ background: "radial-gradient(circle, rgba(236,72,153,0.22) 0%, transparent 70%)" }} />
        <div className="absolute inset-0 dot-grid" />
      </div>

      {/* Left panel — brand + trust */}
      <aside className="hidden md:flex flex-col justify-between p-12 relative border-r border-line/40 bg-bg-1/40 backdrop-blur">
        <Link href="/" className="flex items-center gap-2.5 group w-fit">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow group-hover:scale-105 transition-transform">
            <Play className="h-4 w-4 text-white fill-white" strokeWidth={0} />
          </div>
          <span className="font-semibold tracking-tight">Shortsmith</span>
        </Link>

        <div className="space-y-6 max-w-md">
          <div className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-bg-1/70 px-3 py-1 text-xs text-neutral-300">
            <Sparkles className="h-3 w-3 text-accent" />
            Welcome back
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight">
            Every video, <span className="text-gradient-static">researched, cut, and published</span> without you.
          </h1>
          <ul className="space-y-3 text-sm text-neutral-400">
            <TrustLine>Multi-account YouTube publishing</TrustLine>
            <TrustLine>Neural narration in 20+ languages</TrustLine>
            <TrustLine>Schedule once, publish forever</TrustLine>
          </ul>
        </div>

        <div className="text-xs text-neutral-500">
          © {new Date().getUTCFullYear()} Shortsmith
        </div>
      </aside>

      {/* Right panel — form */}
      <main className="flex flex-col items-center justify-center p-6 md:p-12 relative">
        {/* Mobile brand strip */}
        <Link href="/" className="md:hidden absolute top-6 left-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow">
            <Play className="h-3.5 w-3.5 text-white fill-white" strokeWidth={0} />
          </div>
          <span className="font-semibold tracking-tight text-sm">Shortsmith</span>
        </Link>

        <div className="w-full max-w-sm animate-[fadeUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]">
          <div className="space-y-2 mb-8">
            <h2 className="text-2xl font-semibold tracking-tight">Sign in to your studio</h2>
            <p className="text-sm text-neutral-400">
              {mode === "v2"
                ? "Use your email and password. Session lasts 30 days."
                : "Operator break-glass — legacy master password only."}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === "v2" && (
              <div>
                <label className="label flex items-center gap-1"><Mail className="h-3 w-3" /> Email</label>
                <input
                  type="email"
                  className="input h-11"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>
            )}

            <div>
              <label className="label flex items-center gap-1"><KeyRound className="h-3 w-3" /> Password</label>
              <input
                type="password"
                className="input h-11 font-mono"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus={mode === "v1"}
                autoComplete={mode === "v2" ? "current-password" : "off"}
                placeholder="••••••••••••"
              />
            </div>

            {error && (
              <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/[0.06] rounded-lg px-3.5 py-2.5 animate-[fadeIn_0.2s_ease-out]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !canSubmit}
              className="btn btn-primary w-full h-11 text-sm mt-6 group"
            >
              {busy
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Signing in…</>
                : <>Sign in <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" /></>}
            </button>

            <div className="flex items-center justify-between text-xs text-neutral-500 pt-3">
              <button
                type="button"
                onClick={() => { setMode(mode === "v2" ? "v1" : "v2"); setError(null); }}
                className="hover:text-neutral-300 transition"
              >
                {mode === "v2" ? "Use master password" : "Use email + password"}
              </button>
              {mode === "v2" && (
                <Link href="/signup" className="hover:text-neutral-300 transition">Create account →</Link>
              )}
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

function TrustLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <div className="h-5 w-5 rounded-md bg-accent/15 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
        <div className="h-1.5 w-1.5 rounded-full bg-accent" />
      </div>
      <span>{children}</span>
    </li>
  );
}
