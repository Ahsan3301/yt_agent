"use client";

import {
  createContext, useContext, useState, useCallback, type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, X, Info } from "lucide-react";
import clsx from "clsx";

/**
 * Lightweight global toasts. No deps, no portal — renders a fixed
 * stack in the bottom-right that any component can push to via the
 * useToast() hook.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.success("Saved");
 *   toast.error("Upload failed", "Check R2 creds");
 *   toast.info("Worker dispatched");
 *
 * Each toast auto-dismisses after 5 sec (errors stay 10 sec). Click
 * the × to dismiss manually.
 */
export type ToastKind = "success" | "error" | "warn" | "info";

export type ToastItem = {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  createdAt: number;
};

type ToastContextValue = {
  push: (kind: ToastKind, title: string, body?: string) => void;
  success: (title: string, body?: string) => void;
  error:   (title: string, body?: string) => void;
  warn:    (title: string, body?: string) => void;
  info:    (title: string, body?: string) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const item: ToastItem = { id, kind, title, body, createdAt: Date.now() };
    setItems((prev) => [...prev, item]);
    const ttl = kind === "error" ? 10_000 : 5_000;
    setTimeout(() => dismiss(id), ttl);
  }, [dismiss]);

  const value: ToastContextValue = {
    push,
    success: (t, b) => push("success", t, b),
    error:   (t, b) => push("error", t, b),
    warn:    (t, b) => push("warn", t, b),
    info:    (t, b) => push("info", t, b),
    dismiss,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast stack */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Soft fallback when used outside the provider (SSR / unmounted).
    return {
      push: () => {}, success: () => {}, error: () => {},
      warn: () => {}, info: () => {}, dismiss: () => {},
    };
  }
  return ctx;
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const map = {
    success: {
      Icon: CheckCircle2,
      cls:  "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
    },
    error: {
      Icon: AlertCircle,
      cls:  "border-red-500/30 bg-red-500/10 text-red-100",
    },
    warn: {
      Icon: AlertTriangle,
      cls:  "border-amber-500/30 bg-amber-500/10 text-amber-100",
    },
    info: {
      Icon: Info,
      cls:  "border-sky-500/30 bg-sky-500/10 text-sky-100",
    },
  }[item.kind];
  const { Icon, cls } = map;
  return (
    <div
      className={clsx(
        "pointer-events-auto rounded-md border px-3 py-2 backdrop-blur shadow-lg",
        "flex items-start gap-2 text-sm animate-in slide-in-from-right",
        cls,
      )}
      role="status"
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{item.title}</div>
        {item.body && (
          <div className="text-xs opacity-80 mt-0.5 break-words">{item.body}</div>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="opacity-60 hover:opacity-100 shrink-0"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
