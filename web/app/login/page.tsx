"use client";

import { useState, useEffect } from "react";
import { Lock, Loader2 } from "lucide-react";

/** Login page. Posts password to /api/auth/login → server sets a signed
 *  cookie → redirects to ?next or /. */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState("/");

  useEffect(() => {
    // Read ?next=… so the login flow returns the user to the page they
    // were trying to reach. Same-origin only (path starts with /).
    const p = new URLSearchParams(window.location.search).get("next");
    if (p && p.startsWith("/") && !p.startsWith("//")) setNextPath(p);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
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

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="card w-full max-w-sm space-y-4"
      >
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Lock className="h-5 w-5 text-accent" />
          Dashboard access
        </div>
        <p className="text-sm text-neutral-400">
          Password required. Session lasts 30 days.
        </p>
        <div>
          <label className="label">Password</label>
          <input
            type="password"
            className="input font-mono"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
        </div>
        {error && (
          <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy || !password}
          className="btn btn-primary w-full"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
