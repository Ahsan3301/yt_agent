import { redirect } from "next/navigation";

/**
 * /app/create used to be a second, competing creation form.
 *
 * The two flows disagreed about which was which: the dashboard
 * labelled this one "Advanced create" while the wizard called it
 * "Quick create", and the wizard advertised itself as the
 * full-control path. The sidebar pointed here — at the weaker of the
 * two, the one that couldn't set language or voice, had no review
 * step, and never bound the chosen YouTube channel.
 *
 * The wizard is now the single path. Its one missing feature —
 * creating a custom topic — was ported into its first step. This
 * redirect keeps old links and bookmarks working.
 */
export default function CreateRedirect() {
  redirect("/app/create/wizard");
}
