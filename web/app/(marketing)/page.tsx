import Link from "next/link";
import { Clapperboard, ArrowRight, Sparkles, Video, LayoutDashboard, Check } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminDb } from "@/lib/firebase-admin";

/**
 * Public landing page.
 *
 * Server-side reads the `landing_content` singleton (id="landingcontent0")
 * populated by superadmin at /superadmin/content. Missing / empty rows
 * fall back to the baked defaults below so the page always renders
 * something sensible (fresh install, PB down, etc.).
 *
 * revalidate=60 caps PB reads to 1 per minute per rendered variant.
 * Toggling a feature/pricing tier is visible within ~60s.
 *
 * Auth behaviour: logged-in visitors get redirected to /app immediately —
 * the landing is unauthenticated-only marketing.
 */
export const revalidate = 60;

const CONTENT_ID = "landingcontent0";

type Feature = { title: string; body: string };
type Tier = { name: string; price: string; sub?: string; features?: string[]; highlight?: boolean };

const DEFAULT_CONTENT = {
  hero_title: "YT Agent",
  hero_sub: "Multi-channel Shorts production on autopilot — research, script, voice, visuals, edit, and upload. All backed by your own workers, or ours.",
  hero_cta_text: "Request access",
  hero_cta_href: "/signup",
  features: [
    { title: "Every step automated", body: "Topic research through YouTube upload — one click." },
    { title: "Per-channel control", body: "Every channel gets its own tone, voice, upload account, and workers." },
    { title: "Bring or share compute", body: "BYO Kaggle on free tier; shared worker pool on paid." },
  ] as Feature[],
  pricing_tiers: [] as Tier[],
  footer_links: [] as Array<{ label: string; href: string }>,
};

async function _loadContent() {
  try {
    const snap = await adminDb().collection("landing_content").doc(CONTENT_ID).get();
    if (!snap.exists) return DEFAULT_CONTENT;
    const d = snap.data() as Record<string, unknown>;
    return {
      hero_title:    String(d.hero_title    || DEFAULT_CONTENT.hero_title),
      hero_sub:      String(d.hero_sub      || DEFAULT_CONTENT.hero_sub),
      hero_cta_text: String(d.hero_cta_text || DEFAULT_CONTENT.hero_cta_text),
      hero_cta_href: String(d.hero_cta_href || DEFAULT_CONTENT.hero_cta_href),
      features:      Array.isArray(d.features)      ? (d.features as Feature[]) : DEFAULT_CONTENT.features,
      pricing_tiers: Array.isArray(d.pricing_tiers) ? (d.pricing_tiers as Tier[]) : DEFAULT_CONTENT.pricing_tiers,
      footer_links:  Array.isArray(d.footer_links)  ? (d.footer_links as Array<{ label: string; href: string }>) : DEFAULT_CONTENT.footer_links,
    };
  } catch {
    return DEFAULT_CONTENT;
  }
}

export default async function LandingPage() {
  const h = await headers();
  const isAuthed = !!h.get("x-user-id");
  if (isAuthed) redirect("/app");

  const c = await _loadContent();

  return (
    <div className="flex-1 flex flex-col">
      {/* Hero */}
      <section className="flex-1 flex items-center justify-center px-6 pt-16 pb-8">
        <div className="w-full max-w-3xl text-center space-y-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-line bg-bg-1 px-4 py-1.5 text-xs text-neutral-400">
            <Sparkles className="h-3 w-3 text-accent" />
            Automated YouTube Shorts studio
          </div>

          <div className="flex flex-col items-center gap-4">
            <Clapperboard className="h-14 w-14 text-accent" />
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
              {c.hero_title}
            </h1>
            <p className="text-lg text-neutral-400 max-w-xl">
              {c.hero_sub}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href={c.hero_cta_href || "/signup"} className="btn btn-primary h-10 px-5">
              {c.hero_cta_text} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/login" className="btn h-10 px-5 border-line">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      {c.features.length > 0 && (
        <section className="px-6 pb-10">
          <div className="mx-auto max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-3">
            {c.features.map((f, i) => (
              <FeatureCard key={i} icon={[Video, LayoutDashboard, Sparkles][i % 3]} title={f.title} body={f.body} />
            ))}
          </div>
        </section>
      )}

      {/* Pricing */}
      {c.pricing_tiers.length > 0 && (
        <section className="px-6 pb-16">
          <div className="mx-auto max-w-4xl">
            <h2 className="text-center text-2xl font-semibold mb-6">Pricing</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {c.pricing_tiers.map((t, i) => (
                <div key={i}
                     className={`rounded-lg border p-5 space-y-3 ${
                       t.highlight
                         ? "border-accent/50 bg-accent/5"
                         : "border-line bg-bg-1"
                     }`}>
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-2xl font-bold">{t.price}</div>
                  {t.sub && <div className="text-xs text-neutral-500">{t.sub}</div>}
                  {t.features && t.features.length > 0 && (
                    <ul className="space-y-1.5 text-xs pt-2">
                      {t.features.map((f, j) => (
                        <li key={j} className="flex items-start gap-1.5">
                          <Check className="h-3 w-3 text-accent mt-0.5 shrink-0" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="border-t border-line px-6 py-6 mt-auto">
        <div className="mx-auto max-w-4xl flex flex-wrap items-center justify-between gap-4 text-xs text-neutral-500">
          <div className="flex items-center gap-2">
            <Clapperboard className="h-4 w-4 text-accent/70" />
            <span>YT Agent</span>
          </div>
          <div className="flex flex-wrap gap-4">
            {c.footer_links.map((l, i) => (
              <Link key={i} href={l.href} className="hover:text-neutral-300">{l.label}</Link>
            ))}
          </div>
        </div>
      </footer>
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
