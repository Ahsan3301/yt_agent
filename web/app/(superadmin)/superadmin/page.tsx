import Link from "next/link";
import { Flag, Package, LayoutTemplate, ScrollText, Crown } from "lucide-react";

/**
 * /superadmin index — Phase 3 placeholder. Phase 4 wires landing CMS +
 * plans CRUD; Phase 6 wires the feature-flag toggler + global settings.
 */
export default function SuperadminHome() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Crown className="h-5 w-5 text-amber-400" />
        <h1 className="text-xl font-semibold">Superadmin</h1>
      </div>
      <p className="text-sm text-neutral-400">
        Reserved for the operator. Every action here is logged to
        <code className="mx-1 px-1 rounded bg-bg-2 text-xs">audit_log</code>.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card href="/superadmin/content" icon={LayoutTemplate} title="Landing content" body="Edit hero, features, pricing tiers." />
        <Card href="/superadmin/plans" icon={Package} title="Plans" body="Create / edit paid tiers &amp; quotas." />
        <Card href="/superadmin/flags" icon={Flag} title="Feature flags" body="Toggle SaaS behaviours live (Phase 6)." disabled />
        <Card href="/superadmin/audit" icon={ScrollText} title="Audit log" body="Every superadmin action (later phase)." disabled />
      </div>
    </div>
  );
}

function Card({
  href, icon: Icon, title, body, disabled,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string; body: string; disabled?: boolean;
}) {
  const inner = (
    <div className={`rounded-lg border border-line bg-bg-1 p-4 space-y-2 ${disabled ? "opacity-40" : "hover:border-accent/50 transition"}`}>
      <Icon className="h-5 w-5 text-accent" />
      <div className="font-medium text-sm">{title}</div>
      <div className="text-xs text-neutral-500">{body}</div>
    </div>
  );
  return disabled ? inner : <Link href={href}>{inner}</Link>;
}
