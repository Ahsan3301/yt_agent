"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

/**
 * The one form component behind contact, quote request and custom niche
 * request.
 *
 * Three near-identical forms hand-written three times is three chances
 * to forget the error state, or the disabled-while-submitting guard, or
 * to leave a success message that lies when the request actually failed.
 * The field list is data; everything about behaviour is here once.
 *
 * Deliberate choices:
 *  - The success state REPLACES the form. Leaving a filled-in form on
 *    screen under a green tick invites a second submission.
 *  - Errors keep the entered values. Retyping a paragraph because the
 *    network blipped is the fastest way to lose the enquiry.
 *  - The honeypot is a real input, visually hidden and off the tab
 *    order, not `display:none` — some bots skip hidden inputs but fill
 *    anything they can parse.
 */

export type Field = {
  name: string;
  label: string;
  type?: "text" | "email" | "textarea" | "select";
  placeholder?: string;
  required?: boolean;
  /** Shown under the input — say why you're asking. */
  help?: string;
  options?: string[];
  /** Half-width on desktop, so related short fields pair up. */
  half?: boolean;
};

export function InboundForm({
  endpoint,
  fields,
  submitLabel,
  successTitle,
  successBody,
  compact,
}: {
  endpoint: string;
  fields: Field[];
  submitLabel: string;
  successTitle: string;
  successBody: string;
  compact?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) setDone(true);
      else setError(j.error || "Something went wrong. Please try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-2xl border border-success/25 bg-success/[0.06] p-6 text-center">
        <CheckCircle2 className="h-6 w-6 text-success mx-auto mb-3" />
        <div className="text-white font-medium">{successTitle}</div>
        <p className="text-sm text-neutral-400 mt-1.5 max-w-md mx-auto">{successBody}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className={compact ? "space-y-4" : "grid grid-cols-1 md:grid-cols-2 gap-4"}>
        {fields.map((f) => {
          const id = `f_${f.name}`;
          const wide = compact || !f.half;
          return (
            <div key={f.name} className={wide ? "md:col-span-2" : ""}>
              <label htmlFor={id} className="block text-xs font-medium text-neutral-300 mb-1.5">
                {f.label}
                {!f.required && <span className="text-neutral-600 font-normal"> · optional</span>}
              </label>

              {f.type === "textarea" ? (
                <textarea
                  id={id}
                  rows={4}
                  required={f.required}
                  placeholder={f.placeholder}
                  value={values[f.name] || ""}
                  onChange={(e) => set(f.name, e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-white placeholder:text-neutral-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30 transition"
                />
              ) : f.type === "select" ? (
                <select
                  id={id}
                  required={f.required}
                  value={values[f.name] || ""}
                  onChange={(e) => set(f.name, e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-white focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30 transition"
                >
                  <option value="">Select…</option>
                  {(f.options || []).map((o) => (
                    <option key={o} value={o} className="bg-neutral-900">{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={f.type || "text"}
                  required={f.required}
                  placeholder={f.placeholder}
                  value={values[f.name] || ""}
                  onChange={(e) => set(f.name, e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-white placeholder:text-neutral-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30 transition"
                />
              )}

              {f.help && <p className="text-[11px] text-neutral-500 mt-1">{f.help}</p>}
            </div>
          );
        })}
      </div>

      {/* Honeypot — hidden from people, not from parsers. */}
      <div aria-hidden className="absolute w-px h-px -left-[9999px] overflow-hidden">
        <label htmlFor="f_website">Website</label>
        <input
          id="f_website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={values.website || ""}
          onChange={(e) => set("website", e.target.value)}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full md:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : submitLabel}
      </button>

      <p className="text-[11px] text-neutral-600">
        We use your email only to reply to this message.
      </p>
    </form>
  );
}
