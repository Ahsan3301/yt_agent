"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Play, Settings, History, KeyRound, LayoutDashboard, Activity,
  ListChecks, Wand2, HeartPulse, Layers, Menu, X, HardDrive, BarChart3,
  Shield, Crown, Users, Flag, Package, LayoutTemplate, ScrollText,
} from "lucide-react";
import clsx from "clsx";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
type Role = "user" | "admin" | "superadmin";

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

  const brand = (
    <Link href="/app" className="flex items-center gap-2.5 px-3 pb-5 mb-3 border-b border-line/60 group">
      <div className="relative h-9 w-9 rounded-xl bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow group-hover:scale-105 transition-transform">
        <Play className="h-4 w-4 text-white fill-white" strokeWidth={0} />
      </div>
      <div>
        <div className="font-semibold leading-tight text-[15px] tracking-tight">Shortsmith</div>
        <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Studio</div>
      </div>
    </Link>
  );

  const renderGroup = (label: string | null, items: NavItem[]) => {
    if (!items.length) return null;
    return (
      <div className="flex flex-col gap-0.5">
        {label && (
          <div className="px-3 pt-4 pb-1 text-[10px] uppercase tracking-[0.15em] text-neutral-500">
            {label}
          </div>
        )}
        {items.map(({ href, label: text, icon: Icon }) => (
          <Link key={href} href={href}
                className={clsx("nav-item", isActive(href) && "nav-item-active")}>
            <Icon className={clsx("h-4 w-4 transition-colors", isActive(href) ? "text-accent" : "")} />
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
                          justify-between border-b border-line/60 bg-bg-1/95
                          backdrop-blur px-4 py-3">
        <Link href="/app" className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow">
            <Play className="h-3.5 w-3.5 text-white fill-white" strokeWidth={0} />
          </div>
          <span className="font-semibold text-sm tracking-tight">Shortsmith</span>
        </Link>
        <button onClick={() => setOpen(true)} className="btn-ghost p-2 rounded-md hover:bg-bg-2"
                aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]"
               onClick={() => setOpen(false)} />
          <aside className="relative w-72 max-w-[85vw] bg-bg-1/95 backdrop-blur border-r border-line/60
                            px-3 py-6 flex flex-col gap-1 overflow-y-auto
                            animate-[fadeUp_0.3s_cubic-bezier(0.16,1,0.3,1)_both]">
            <div className="flex items-center justify-between px-1 pb-3 mb-2 border-b border-line/60">
              <Link href="/app" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent via-accent-glow to-accent-spark flex items-center justify-center shadow-glow">
                  <Play className="h-4 w-4 text-white fill-white" strokeWidth={0} />
                </div>
                <span className="font-semibold tracking-tight">Shortsmith</span>
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
      <aside className="hidden md:flex md:w-64 flex-col gap-1 border-r border-line/60 bg-bg-1/60 backdrop-blur px-3 py-6 shrink-0 overflow-y-auto">
        {brand}
        {renderGroup(null, groups.user)}
        {renderGroup("Admin", groups.admin)}
        {renderGroup("Superadmin", groups.superadmin)}
      </aside>
    </>
  );
}
