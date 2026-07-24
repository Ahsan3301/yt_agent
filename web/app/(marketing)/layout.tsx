/**
 * Marketing / public route-group layout. No sidebar, no auth chrome —
 * just a full-width container with sensible defaults. Actual pages:
 *   /         (landing — Phase 4 CMS-driven; placeholder for now)
 *   /login    (auth entry)
 *   /signup   (Phase 4)
 *   /pricing  (Phase 4 — SSR from plans collection)
 *   /features (Phase 4)
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      {children}
    </div>
  );
}
