"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Settings, History, KeyRound, LayoutDashboard, Activity,
  ListChecks, Wand2, HeartPulse, Layers, Menu, X, HardDrive, BarChart3,
  Shield, Crown, Users, Flag, Package, LayoutTemplate, ScrollText, Sparkles,
  SlidersHorizontal, LogOut
} from "lucide-react";
import clsx from "clsx";
import { Logo } from "@/components/Logo";

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

/** The four primary destinations on the mobile tab bar, plus More.
 *  Chosen as the things a user opens repeatedly — everything else
 *  lives one tap deeper in the drawer.
 *
 *  Library over Queue: finished videos are what someone comes back to
 *  look at, while the queue matters only while something is rendering.
 *  Queue keeps its sidebar entry and is one tap away under More. */
const TABS: NavItem[] = [
  { href: "/app",               label: "Home",     icon: LayoutDashboard },
  { href: "/app/create/wizard", label: "Create",   icon: Wand2           },
  { href: "/app/channels",      label: "Channels", icon: Layers          },
  { href: "/app/history",       label: "Library",  icon: History         },
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
      <Logo className="h-7 w-auto group-hover:scale-[1.03] transition-transform" />
      {/* "Studio" is a rail label, not part of the logo, so it sits
          outside the lockup behind a divider rather than being set in a
          different typeface underneath the real wordmark. */}
      <span className="pl-2.5 border-l border-line/60 text-[10px] text-neutral-500 uppercase tracking-wider">
        Studio
      </span>
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
        <Link href="/app" aria-label="Yven — dashboard">
          <Logo className="h-6 w-auto" />
        </Link>
        {/* No hamburger here any more. The bottom tab bar's More tab
            opens the same drawer, and two entry points to one menu — one
            of them out of thumb reach at the top of the screen — is the
            web habit this redesign is replacing. The bar stays as a
            brand header, which is what a native app puts here. */}
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
              <Link href="/app" onClick={() => setOpen(false)} aria-label="Yven — dashboard">
                <Logo className="h-6 w-auto" />
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


      {/* ── Mobile bottom tab bar ────────────────────────────────
          Phones get a native app pattern rather than a hamburger:
          thumb-reachable, always visible, and it shows WHERE you are
          without opening anything. A drawer hides both the destinations
          and the current location behind a tap.

          Five slots is the iOS/Android convention and the practical
          limit at 375px — four primary destinations plus More, which
          opens the full drawer for everything else (Settings, Reports,
          Referrals, and the Admin groups).

          pb-[env(safe-area-inset-bottom)] keeps it clear of the iPhone
          home indicator; without it the labels sit under the gesture
          bar on every modern iPhone. */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-line/60
                      bg-bg-1/80 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]"
           aria-label="Primary">
        <div className="grid grid-cols-5">
          {TABS.map(({ href, label: text, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className="relative flex flex-col items-center justify-center gap-1 py-2.5
                           active:scale-[0.92] transition-transform duration-100 select-none"
              >
                {/* Active pill above the icon — the iOS cue for "you are
                    here", readable at a glance without colour alone. */}
                <span className={clsx(
                  "absolute top-0 h-[3px] w-8 rounded-full transition-all duration-200",
                  active ? "bg-accent opacity-100" : "opacity-0",
                )} />
                <Icon className={clsx("h-[22px] w-[22px] transition-colors",
                                      active ? "text-accent" : "text-neutral-500")} />
                <span className={clsx("text-[10px] leading-none tracking-tight transition-colors",
                                      active ? "text-accent font-semibold" : "text-neutral-500")}>
                  {text}
                </span>
              </Link>
            );
          })}

          <button
            onClick={() => setOpen(true)}
            aria-label="More"
            className="relative flex flex-col items-center justify-center gap-1 py-2.5
                       active:scale-[0.92] transition-transform duration-100 select-none"
          >
            <Menu className="h-[22px] w-[22px] text-neutral-500" />
            <span className="text-[10px] leading-none tracking-tight text-neutral-500">More</span>
          </button>
        </div>
      </nav>

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
