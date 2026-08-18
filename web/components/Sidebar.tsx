"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Play, Settings, History, KeyRound, LayoutDashboard, Activity,
  ListChecks, Wand2, HeartPulse, Layers, Menu, X, HardDrive, BarChart3,
  Shield, Crown, Users, Flag, Package, LayoutTemplate, ScrollText, Sparkles,
  SlidersHorizontal, LogOut
} from "lucide-react";
import clsx from "clsx";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
type Role = "user" | "admin" | "superadmin";

const USER_NAV: NavItem[] = [
  { href: "/app",           label: "Dashboard",   icon: LayoutDashboard },
  { href: "/app/create/wizard", label: "Create", icon: Wand2 },
  { href: "/app/channels",  label: "Channels",    icon: Layers          },
  { href: "/app/queue",     label: "Job queue",   icon: ListChecks      },
  { href: "/app/reports",   label: "Reports",     icon: BarChart3       },
  { href: "/app/history",   label: "Library",     icon: History         },
  { href: "/app/settings",  label: "Settings",    icon: Settings        },
  { href: "/app/referrals", label: "Referrals",   icon: Sparkles        },
];

// Operator surfaces. These were in USER_NAV, so every customer saw
// worker controls, MinIO cleanup and the provider API keys — the
// machinery they are buying a result from, not a feature of the
// product. Moved here; middleware enforces the same boundary so a
// typed URL cannot get around it.
const ADMIN_NAV: NavItem[] = [
  { href: "/app/storage",   label: "Storage",     icon: HardDrive       },
  { href: "/app/keys",      label: "Connections", icon: KeyRound        },
  { href: "/admin",         label: "Admin",       icon: Shield          },
  { href: "/admin/monitor", label: "Workers",     icon: Activity        },
  { href: "/admin/health",  label: "Health",      icon: HeartPulse      },
  { href: "/admin/users",   label: "Users",       icon: Users           },
];

const SUPERADMIN_NAV: NavItem[] = [
  { href: "/superadmin",           label: "Superadmin",   icon: Crown           },
  { href: "/superadmin/content",   label: "Landing",      icon: LayoutTemplate  },
  { href: "/superadmin/roadmap",   label: "Roadmap",      icon: ScrollText      },
  { href: "/superadmin/plans",     label: "Plans",        icon: Package         },
  { href: "/superadmin/quotas",    label: "Quota reqs",   icon: Package         },
  { href: "/superadmin/pool",      label: "Key pool",     icon: Layers          },
  { href: "/superadmin/config",    label: "Configuration", icon: SlidersHorizontal },
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


/**
 * Sign out.
 *
 * There was no way to log out anywhere in the product — the only exit
 * was clearing the cookie by hand. On a shared or borrowed machine
 * that is not an inconvenience, it is the session staying open for
 * whoever sits down next.
 *
 * Posts to /api/auth/logout then hard-navigates, so no client cache
 * survives with the previous user's data in it.
 */
function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await fetch("/api/auth/logout", { method: "POST" }); }
        catch { /* leaving anyway */ }
        window.location.href = "/login";
      }}
      className="mt-auto flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-neutral-500 hover:text-white hover:bg-white/[0.04] transition w-full disabled:opacity-50"
    >
      <LogOut className="h-4 w-4" />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
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
      <div className="relative h-9 w-9 rounded-xl bg-gradient-to-br from-accent via-accent-2 to-accent-glow flex items-center justify-center shadow-[0_0_20px_rgba(167,139,250,0.35)] group-hover:scale-105 transition-transform">
        <Play className="h-4 w-4 text-[#050508] fill-[#050508]" strokeWidth={0} />
      </div>
      <div>
        <div className="font-bold leading-tight text-[15px] tracking-tight bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">Yven</div>
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
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-accent via-accent-2 to-accent-glow flex items-center justify-center shadow-[0_0_16px_rgba(167,139,250,0.3)]">
            <Play className="h-3.5 w-3.5 text-[#050508] fill-[#050508]" strokeWidth={0} />
          </div>
          <span className="font-bold text-sm tracking-tight bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">Yven</span>
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
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent via-accent-2 to-accent-glow flex items-center justify-center shadow-[0_0_16px_rgba(167,139,250,0.3)]">
                  <Play className="h-4 w-4 text-[#050508] fill-[#050508]" strokeWidth={0} />
                </div>
                <span className="font-bold tracking-tight bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">Yven</span>
              </Link>
              <button onClick={() => setOpen(false)} className="p-2 rounded-md hover:bg-bg-2"
                      aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            {renderGroup(null, groups.user)}
            {renderGroup("Admin", groups.admin)}
            {renderGroup("Superadmin", groups.superadmin)}
            <SignOut />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-64 flex-col gap-1 border-r border-line/60 bg-bg-1/60 backdrop-blur px-3 py-6 shrink-0 overflow-y-auto">
        {brand}
        {renderGroup(null, groups.user)}
        {renderGroup("Admin", groups.admin)}
        {renderGroup("Superadmin", groups.superadmin)}
        <SignOut />
      </aside>
    </>
  );
}
