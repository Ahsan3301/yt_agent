"use client";

import { useState } from "react";
import Link from "next/link";
import { UserPlus, Loader2, ArrowLeft, CheckCircle2, KeyRound, Mail } from "lucide-react";

/**
 * Public signup form. POSTs to /api/auth/register (gated by
 * `signup_open` feature flag — 403 when closed with a clear message).
 *
 * Success state shows a "pending approval" panel — no auto-login,
 * because the account isn't `active` until a superadmin approves it.
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
          email,
          password,
          kaggle_username: kaggleUser.trim(),
          kaggle_key: kaggleKey.trim(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setDone(true);
      } else {
        setError(j.error || `HTTP ${r.status}`);
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="card w-full max-w-md space-y-4 text-center">
          <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto" />
          <div className="text-lg font-semibold">Account created</div>
          <p className="text-sm text-neutral-400">
            Your signup is pending admin approval. You&apos;ll be able to sign
            in once an operator reviews and activates your account.
          </p>
          <Link href="/" className="btn btn-ghost inline-flex mt-2">
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <UserPlus className="h-5 w-5 text-accent" />
          Request access
        </div>
        <p className="text-sm text-neutral-400">
          Signups are review-gated. After creating an account, an operator
          approves it before you can sign in.
        </p>

        <div>
          <label className="label flex items-center gap-1"><Mail className="h-3 w-3" /> Email</label>
          <input type="email" className="input" required autoComplete="email"
                 value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>

        <div>
          <label className="label flex items-center gap-1"><KeyRound className="h-3 w-3" /> Password (10+ chars)</label>
          <input type="password" className="input font-mono" required autoComplete="new-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        <div>
          <label className="label">Confirm password</label>
          <input type="password" className="input font-mono" required autoComplete="new-password"
                 value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        <div className="border-t border-line pt-3 space-y-2">
          <div className="text-xs text-neutral-500 -mb-1">
            Optional — bring your own Kaggle worker (skips shared queue). You can add these later.
          </div>
          <div>
            <label className="label">Kaggle username</label>
            <input type="text" className="input" placeholder="e.g. yourname"
                   value={kaggleUser} onChange={(e) => setKaggleUser(e.target.value)} />
          </div>
          <div>
            <label className="label">Kaggle API key</label>
            <input type="password" className="input font-mono" placeholder="from kaggle.com/account"
                   value={kaggleKey} onChange={(e) => setKaggleKey(e.target.value)} />
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-300 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">
            {error}
          </div>
        )}

        <button type="submit" disabled={busy || !email || !password}
                className="btn btn-primary w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          {busy ? "Creating account…" : "Create account"}
        </button>

        <div className="flex items-center justify-between text-xs text-neutral-500 pt-1">
          <Link href="/" className="underline hover:text-neutral-300">← Home</Link>
          <Link href="/login" className="underline hover:text-neutral-300">Already have an account?</Link>
        </div>
      </form>
    </div>
  );
}
