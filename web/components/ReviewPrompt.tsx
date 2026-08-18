"use client";

import { useEffect, useState } from "react";
import { Star, X } from "lucide-react";

/**
 * Asks for a G2 / Capterra review once a user has published a few videos.
 *
 * SKIPPABLE, AND IT MEANS IT. Dismissing records a timestamp server-side
 * and the prompt stays gone for two weeks, across devices. A dismissal
 * that only survives until the next page load is how a polite ask turns
 * into the thing people write one-star reviews about.
 *
 * Nothing is withheld from anyone who ignores it. G2 and Capterra both
 * prohibit review gating — conditioning access, features or rewards on
 * leaving a review — and enforcement includes purging the reviews and
 * suspending the vendor profile. The ask is worth making; gating it
 * would put the reviews it earns at risk.
 *
 * Renders nothing until the server says to show it, so it costs a
 * logged-out or ineligible user nothing but one fetch.
 */

type State = {
  show: boolean;
  published?: number;
  url_g2?: string;
  url_capterra?: string;
};

export default function ReviewPrompt() {
  const [s, setS] = useState<State | null>(null);
  const [gone, setGone] = useState(false);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    fetch("/api/review-prompt")
      .then((r) => r.json())
      .then((d) => setS(d?.show ? d : { show: false }))
      .catch(() => setS({ show: false }));   // never break the page
  }, []);

  const send = async (action: "dismiss" | "submitted") => {
    if (action === "submitted") setThanks(true);
    else setGone(true);
    try {
      await fetch("/api/review-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {
      // The local state already reflects the choice; a failed write only
      // means we ask again sooner, which is the harmless direction.
    }
  };

  if (!s?.show || gone) return null;

  if (thanks) {
    return (
      <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/[0.05] p-5 text-sm text-emerald-200">
        Thank you — that genuinely helps a small team.
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <button
        onClick={() => send("dismiss")}
        aria-label="Dismiss"
        className="absolute top-4 right-4 text-neutral-500 hover:text-white transition"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-start gap-3 pr-8">
        <div className="mt-0.5 flex gap-0.5 shrink-0">
          {[0, 1, 2, 3, 4].map((i) => (
            <Star key={i} className="h-3.5 w-3.5 fill-amber-300 text-amber-300" />
          ))}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">
            {s.published
              ? `You've published ${s.published} videos with Yven.`
              : "Enjoying Yven?"}
          </h3>
          <p className="mt-1.5 text-sm text-neutral-400 leading-relaxed">
            If it has saved you time, a short review on G2 or Capterra helps other
            creators find us. It takes about two minutes, and we read every one.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href={s.url_g2}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => send("submitted")}
              className="px-4 py-2 rounded-full bg-white text-black text-xs font-semibold hover:bg-neutral-200 transition"
            >
              Review on G2
            </a>
            <a
              href={s.url_capterra}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => send("submitted")}
              className="px-4 py-2 rounded-full border border-white/15 text-xs font-medium text-neutral-200 hover:text-white hover:border-white/30 transition"
            >
              Review on Capterra
            </a>
            <button
              onClick={() => send("dismiss")}
              className="px-4 py-2 rounded-full text-xs font-medium text-neutral-500 hover:text-neutral-300 transition"
            >
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
