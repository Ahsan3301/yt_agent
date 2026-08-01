"use client";

import Link from "next/link";
import { Check, ArrowRight, Loader2 } from "lucide-react";

/**
 * First-run setup guide.
 *
 * The dashboard previously offered nothing to a new user but four
 * zeroes, an operator-facing preflight warning telling them to "launch
 * Colab or wake Kaggle", and an empty state that disappeared the
 * moment they created a channel — i.e. it vanished part-way through
 * setup, i.e. exactly when guidance was still needed.
 *
 * This stays until the account has actually published something, and
 * marks each step from real state rather than from a dismissable flag,
 * so it can't claim a step is done when it isn't.
 */

export type SetupState = {
  hasYouTube: boolean;
  hasChannel: boolean;
  hasRun: boolean;
  /** Any connected channel currently failing its health check. */
  brokenConnections: number;
  loading: boolean;
};

export function SetupChecklist({ s }: { s: SetupState }) {
  // Once they've published, setup is over — get out of the way.
  if (s.loading || s.hasRun) return null;

  const steps = [
    {
      done: s.hasYouTube,
      title: "Connect your YouTube channel",
      body: "One sign-in with Google. This is where your videos get published.",
      href: "/app/channels",
      cta: "Connect YouTube",
    },
    {
      done: s.hasChannel,
      title: "Tell us what your channel is about",
      body: "Pick a topic and a voice. We use this to write scripts that sound like you.",
      href: "/app/channels",
      cta: "Set up a channel",
    },
    {
      done: false,
      title: "Make your first video",
      body: "Give us an idea — we handle the script, voiceover, visuals and editing.",
      href: "/app/create/wizard",
      cta: "Create a video",
    },
  ];

  const doneCount = steps.filter((x) => x.done).length;
  const current = steps.findIndex((x) => !x.done);

  return (
    <div className="card space-y-5 border-accent/20 bg-gradient-to-br from-accent/[0.05] to-transparent">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-base font-semibold">Get your first video published</div>
          <div className="text-sm text-neutral-400 mt-0.5">
            Three steps, about five minutes.
          </div>
        </div>
        <div className="text-xs text-neutral-400 tabular-nums">
          {doneCount} of {steps.length} done
        </div>
      </div>

      <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-500"
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>

      <div className="space-y-2.5">
        {steps.map((step, i) => {
          const isCurrent = i === current;
          return (
            <div
              key={step.title}
              className={
                "flex items-start gap-3 rounded-xl px-3.5 py-3 transition " +
                (isCurrent ? "bg-white/[0.04] border border-accent/20" : "border border-transparent")
              }
            >
              <div className={
                "mt-0.5 h-5 w-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold " +
                (step.done ? "bg-success/20 text-success"
                  : isCurrent ? "bg-accent/25 text-accent"
                  : "bg-white/[0.06] text-neutral-500")
              }>
                {step.done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </div>

              <div className="min-w-0 flex-1">
                <div className={
                  "text-sm font-medium " +
                  (step.done ? "text-neutral-400 line-through decoration-neutral-600" : "")
                }>
                  {step.title}
                </div>
                {!step.done && (
                  <div className="text-xs text-neutral-500 mt-0.5">{step.body}</div>
                )}
              </div>

              {isCurrent && (
                <Link href={step.href} className="btn btn-primary h-8 text-xs shrink-0">
                  {step.cta} <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          );
        })}
      </div>

      {/* A dead connection would make step 3 fail at the very last
          moment, after the render has already been paid for — so warn
          before they spend it, not after. */}
      {s.brokenConnections > 0 && (
        <div className="rounded-xl border border-danger/25 bg-danger/[0.05] px-3.5 py-3 text-sm">
          <span className="text-red-300 font-medium">
            {s.brokenConnections} channel{s.brokenConnections === 1 ? "" : "s"} need reconnecting.
          </span>{" "}
          <span className="text-neutral-400">
            Videos can&apos;t publish there until you sign in again.
          </span>{" "}
          <Link href="/app/channels" className="text-accent hover:underline">Fix it →</Link>
        </div>
      )}
    </div>
  );
}

/** Skeleton so the dashboard doesn't jump when state resolves. */
export function SetupChecklistSkeleton() {
  return (
    <div className="card flex items-center gap-2 text-sm text-neutral-500">
      <Loader2 className="h-4 w-4 animate-spin" /> Checking your setup…
    </div>
  );
}
