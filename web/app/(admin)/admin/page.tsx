import Link from "next/link";
import { Users, Activity, HeartPulse, ListChecks, Shield } from "lucide-react";

/**
 * /admin index — quick links to admin surfaces. Real dashboards (user
 * approvals, cross-tenant queue, error feed) land in Phase 4.
 */
export default function AdminHome() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Shield className="h-5 w-5 text-accent" />
        <h1 className="text-xl font-semibold">Admin</h1>
      </div>
      <p className="text-sm text-neutral-400">
        Operator-only surfaces. User approvals + cross-tenant read
        views are added in Phase 4; workers &amp; health are here today.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <AdminCard href="/admin/users" icon={Users} title="Users" body="Approve / suspend signups (Phase 4)." disabled />
        <AdminCard href="/admin/monitor" icon={Activity} title="Workers" body="CPU / RAM / GPU / disk per backend." />
        <AdminCard href="/admin/health" icon={HeartPulse} title="Health" body="Registry, error feed, uptime." />
        <AdminCard href="/admin/queue" icon={ListChecks} title="Cross-tenant queue" body="All users' jobs (Phase 4)." disabled />
      </div>
    </div>
  );
}

function AdminCard({
  href, icon: Icon, title, body, disabled,
}: {
  href: string; icon: React.ComponentType<{ className?: string }>;
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
