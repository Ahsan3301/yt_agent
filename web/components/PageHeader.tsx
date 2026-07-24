import { type ReactNode } from "react";

/**
 * Consistent page-header pattern for every /app, /admin, /superadmin
 * page. Left side: eyebrow (small uppercase category) + title + subtitle.
 * Right side: whatever action(s) the caller wants.
 *
 * Usage:
 *   <PageHeader
 *     eyebrow="Studio"
 *     title="Dashboard"
 *     subtitle="Overview of your channels and recent activity"
 *     actions={<Link href="/app/create" className="btn btn-primary">New render</Link>}
 *   />
 */
export function PageHeader({
  eyebrow, title, subtitle, actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 flex-wrap pb-2">
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10px] uppercase tracking-[0.18em] text-accent mb-1.5 font-medium">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-neutral-400 mt-1 max-w-xl">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </header>
  );
}
