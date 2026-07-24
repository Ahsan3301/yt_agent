import Link from "next/link";
import { Clapperboard, ArrowRight, Sparkles, Video, LayoutDashboard } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Public landing page. Phase 3 stub — Phase 4 replaces the hero /
 * features / pricing sections with SSR from the `landing_content` +
 * `plans` collections so the superadmin can edit copy without a code
 * deploy.
 *
 * Behaviour today:
 *   - Logged-in visitor -> immediately redirect to /app.
 *   - Unauthenticated  -> see this placeholder with "Sign in".
 */
export default async function LandingPage() {
  const h = await headers();
  const isAuthed = !!h.get("x-user-id");
  if (isAuthed) redirect("/app");

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-3xl text-center space-y-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-line bg-bg-1 px-4 py-1.5 text-xs text-neutral-400">
          <Sparkles className="h-3 w-3 text-accent" />
          Automated YouTube Shorts studio
        </div>

        <div className="flex flex-col items-center gap-4">
          <Clapperboard className="h-14 w-14 text-accent" />
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            YT Agent
          </h1>
          <p className="text-lg text-neutral-400 max-w-xl">
            Multi-channel Shorts production on autopilot — research, script,
            voice, visuals, edit, and upload. All backed by your own workers,
            or ours.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/login" className="btn btn-primary h-10 px-5">
            Sign in <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/signup" className="btn h-10 px-5 border-line">
            Request access
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-6 text-left">
          <FeatureCard icon={Video} title="Every step automated" body="Topic research through YouTube upload — one click." />
          <FeatureCard icon={LayoutDashboard} title="Per-channel control" body="Every channel gets its own tone, voice, upload account, and workers." />
          <FeatureCard icon={Sparkles} title="Bring or share compute" body="BYO Kaggle on free tier; shared worker pool on paid." />
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  icon: Icon, title, body,
}: { icon: React.ComponentType<{ className?: string }>; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-1 p-4 space-y-2">
      <Icon className="h-5 w-5 text-accent" />
      <div className="font-medium text-sm">{title}</div>
      <div className="text-xs text-neutral-500">{body}</div>
    </div>
  );
}
