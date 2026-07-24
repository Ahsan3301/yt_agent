"use client";

import { useState, useEffect } from "react";
import { Lock, Loader2, Mail, KeyRound } from "lucide-react";

/**
 * Login page — dual-mode.
 *
 * Default view: email + password (v2 auth). This is what public users
 * land on once signups open.
 *
 * "Use master password" toggle: legacy single-password path (v1 auth).
 * Kept so the founder can always recover access even if their app_users
 * row is damaged.
 *
 * Both modes hit the same /api/auth/login endpoint — the route
 * discriminates on payload shape.
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
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Lock className="h-5 w-5 text-accent" />
          Dashboard access
        </div>
        <p className="text-sm text-neutral-400">
          {mode === "v2"
            ? "Sign in with your account. Session lasts 30 days."
            : "Legacy master-password login. Kept for operator break-glass."}
        </p>

        {mode === "v2" && (
          <div>
            <label className="label flex items-center gap-1">
              <Mail className="h-3 w-3" /> Email
            </label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
              autoComplete="email"
            />
          </div>
        )}

        <div>
          <label className="label flex items-center gap-1">
            <KeyRound className="h-3 w-3" /> Password
          </label>
          <input
            type="password"
            className="input font-mono"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus={mode === "v1"}
            autoComplete={mode === "v2" ? "current-password" : "off"}
          />
        </div>

        {error && (
          <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !canSubmit}
          className="btn btn-primary w-full"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <div className="flex items-center justify-between text-xs text-neutral-500 pt-1">
          <button
            type="button"
            onClick={() => { setMode(mode === "v2" ? "v1" : "v2"); setError(null); }}
            className="underline hover:text-neutral-300"
          >
            {mode === "v2" ? "Use master password" : "Use email + password"}
          </button>
          {mode === "v2" && (
            <a href="/signup" className="underline hover:text-neutral-300">Create account</a>
          )}
        </div>
      </form>
    </div>
  );
}
