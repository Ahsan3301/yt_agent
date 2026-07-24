"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Clapperboard, Settings, History, KeyRound, LayoutDashboard, Activity,
  ListChecks, Wand2, HeartPulse, Layers, Menu, X, HardDrive, BarChart3,
  Shield, Crown, Users, Flag, Package, LayoutTemplate, ScrollText,
} from "lucide-react";
import clsx from "clsx";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
type Role = "user" | "admin" | "superadmin";

// User nav — shown to everyone (admins + superadmins also see this + their
// own group below). Kept close to the original list so the day-to-day flow
// (create → channels → queue → history) is unchanged, just under /app.
const USER_NAV: NavItem[] = [
  { href: "/app",           label: "Dashboard",   icon: LayoutDashboard },
  { href: "/app/create",    label: "Create",      icon: Wand2           },
  { href: "/app/channels",  label: "Channels",    icon: Layers          },
  { href: "/app/queue",     label: "Job queue",   icon: ListChecks      },
  { href: "/app/storage",   label: "Storage",     icon: HardDrive       },
  { href: "/app/reports",   label: "Reports",     icon: BarChart3       },
  { href: "/app/history",   label: "Library",     icon: History         },
  { href: "/app/settings",  label: "Settings",    icon: Settings        },
  { href: "/app/keys",      label: "Connections", icon: KeyRound        },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin",         label: "Admin",       icon: Shield          },
  { href: "/admin/monitor", label: "Workers",     icon: Activity        },
  { href: "/admin/health",  label: "Health",      icon: HeartPulse      },
  { href: "/admin/users",   label: "Users",       icon: Users           },
];

const SUPERADMIN_NAV: NavItem[] = [
  { href: "/superadmin",           label: "Superadmin",   icon: Crown           },
  { href: "/superadmin/content",   label: "Landing",      icon: LayoutTemplate  },
  { href: "/superadmin/plans",     label: "Plans",        icon: Package         },
  { href: "/superadmin/flags",     label: "Flags",        icon: Flag            },
  { href: "/superadmin/audit",     label: "Audit log",    icon: ScrollText      },
];

function navForRole(role: Role): { user: NavItem[]; admin: NavItem[]; superadmin: NavItem[] } {
  return {
    user: USER_NAV,
    admin: role === "admin" || role === "superadmin" ? ADMIN_NAV : [],
    superadmin: role === "superadmin" ? SUPERADMIN_NAV : [],
  };
}

export default function Sidebar({ role = "user" }: { role?: Role }) {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);
  const groups = navForRole(role);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const isActive = (href: string) => {
    if (href === "/app" || href === "/admin" || href === "/superadmin") {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  const renderGroup = (label: string | null, items: NavItem[]) => {
    if (!items.length) return null;
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-500">
            {label}
          </div>
        )}
        {items.map(({ href, label: text, icon: Icon }) => (
          <Link key={href} href={href}
                className={clsx("nav-item", isActive(href) && "nav-item-active")}>
            <Icon className="h-4 w-4" />
            {text}
          </Link>
        ))}
      </div>
    );
  };

  return (
    <>
      {/* Mobile top bar */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 flex items-center
                          justify-between border-b border-line bg-bg-1/95
                          backdrop-blur px-4 py-3">
        <Link href="/app" className="flex items-center gap-2">
          <Clapperboard className="h-6 w-6 text-accent" />
          <span className="font-semibold text-sm">YT Agent</span>
        </Link>
        <button onClick={() => setOpen(true)} className="btn-ghost p-2 rounded-md hover:bg-bg-2"
                aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Mobile slide-in drawer */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm"
               onClick={() => setOpen(false)} />
          <aside className="relative w-72 max-w-[85vw] bg-bg-1 border-r border-line
                            px-3 py-6 flex flex-col gap-1 overflow-y-auto animate-in slide-in-from-left">
            <div className="flex items-center justify-between px-3 pb-5 mb-2 border-b border-line">
              <Link href="/app" className="flex items-center gap-3" onClick={() => setOpen(false)}>
                <Clapperboard className="h-7 w-7 text-accent" />
                <div>
                  <div className="font-semibold leading-tight">YT Agent</div>
                  <div className="text-xs text-neutral-500">automation studio</div>
                </div>
              </Link>
              <button onClick={() => setOpen(false)} className="p-2 rounded-md hover:bg-bg-2"
                      aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            {renderGroup(null, groups.user)}
            {renderGroup("Admin", groups.admin)}
            {renderGroup("Superadmin", groups.superadmin)}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-64 flex-col gap-1 border-r border-line bg-bg-1 px-3 py-6 shrink-0 overflow-y-auto">
        <Link href="/app" className="flex items-center gap-3 px-3 pb-5 mb-2 border-b border-line">
          <Clapperboard className="h-7 w-7 text-accent" />
          <div>
            <div className="font-semibold leading-tight">YT Agent</div>
            <div className="text-xs text-neutral-500">automation studio</div>
          </div>
        </Link>
        {renderGroup(null, groups.user)}
        {renderGroup("Admin", groups.admin)}
        {renderGroup("Superadmin", groups.superadmin)}
      </aside>
    </>
  );
}
