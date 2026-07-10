"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Clapperboard, Settings, History, KeyRound, LayoutDashboard, Activity,
  ListChecks, Wand2, HeartPulse, Layers, Menu, X, HardDrive, BarChart3,
} from "lucide-react";
import clsx from "clsx";

const NAV = [
  { href: "/",         label: "Dashboard",   icon: LayoutDashboard },
  { href: "/create",   label: "Create",      icon: Wand2           },
  { href: "/channels", label: "Channels",    icon: Layers          },
  { href: "/queue",    label: "Job queue",   icon: ListChecks      },
  { href: "/monitor",  label: "Workers",     icon: Activity        },
  { href: "/storage",  label: "Storage",     icon: HardDrive       },
  { href: "/health",   label: "Health",      icon: HeartPulse      },
  { href: "/reports",  label: "Reports",     icon: BarChart3       },
  { href: "/history",  label: "Library",     icon: History         },
  { href: "/settings", label: "Settings",    icon: Settings        },
  { href: "/keys",     label: "Connections", icon: KeyRound        },
];

export default function Sidebar() {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);

  // Close drawer on route change.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Esc closes the drawer.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <>
      {/* Mobile top bar (hidden ≥md) */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 flex items-center
                          justify-between border-b border-line bg-bg-1/95
                          backdrop-blur px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
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
                            px-3 py-6 flex flex-col gap-1 animate-in slide-in-from-left">
            <div className="flex items-center justify-between px-3 pb-5 mb-2 border-b border-line">
              <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)}>
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
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link key={href} href={href}
                      className={clsx("nav-item", active && "nav-item-active")}>
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </aside>
        </div>
      )}

      {/* Desktop sidebar (hidden <md) */}
      <aside className="hidden md:flex md:w-64 flex-col gap-1 border-r border-line bg-bg-1 px-3 py-6 shrink-0">
        <Link href="/" className="flex items-center gap-3 px-3 pb-5 mb-2 border-b border-line">
          <Clapperboard className="h-7 w-7 text-accent" />
          <div>
            <div className="font-semibold leading-tight">YT Agent</div>
            <div className="text-xs text-neutral-500">automation studio</div>
          </div>
        </Link>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href}
                  className={clsx("nav-item", active && "nav-item-active")}>
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </aside>
    </>
  );
}
