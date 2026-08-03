import Link from "next/link";
import { Users, Activity, HeartPulse, ListChecks, Shield } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

/**
 * /admin index — quick links to admin surfaces. Real dashboards (user
 * approvals, cross-tenant queue, error feed) land in Phase 4.
 */
export default function AdminHome() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operator"
        icon={Shield}
        title="Admin"
        subtitle="Operator-only surfaces. User approvals and cross-tenant read views arrive in Phase 4; workers and health are here today."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <AdminCard href="/admin/users" icon={Users} title="Users" body="Approve, suspend, and manage signups." />
        <AdminCard href="/admin/monitor" icon={Activity} title="Workers" body="CPU / RAM / GPU / disk per backend." />
        <AdminCard href="/admin/health" icon={HeartPulse} title="Health" body="Registry, error feed, uptime." />
        <AdminCard href="/admin/queue" icon={ListChecks} title="Cross-tenant queue" body="All users' jobs (later phase)." disabled />
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
