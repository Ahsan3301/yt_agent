import { PRESET_CHANNELS } from "@/lib/channels";

/**
 * Visitor-facing descriptions of the built-in niches.
 *
 * Why a separate file from `channels.ts`: that one is the dashboard's
 * functional list (slug, label, research default) and is edited in
 * lock-step with modules/channels.py. This is marketing copy about the
 * same things. Keeping them apart means rewording a sentence on the
 * website can never change what the dashboard offers.
 *
 * Keyed by the same slug, and `NICHES` below is derived from
 * PRESET_CHANNELS rather than hand-listed — so a niche added to the
 * product shows up on the site automatically, with a visible
 * placeholder instead of silently going missing.
 *
 * `research` mirrors research_mode in modules/channels.py and is the
 * honest distinction between the two kinds of channel we run:
 *   sourced  — every claim is checked against live sources before it is
 *              written (fact_research / trend_aggregator)
 *   original — we write the story rather than report one (none)
 * Saying that plainly is better than implying everything is researched.
 */

export type NicheCopy = {
  /** One line, what the channel actually publishes. */
  blurb: string;
  /** A real example of a video this niche would produce. */
  example: string;
  /** Does the pipeline research this niche against live sources? */
  research: "sourced" | "original";
};

const COPY: Record<string, NicheCopy> = {
  pixar: {
    blurb: "Wordless 3D animated shorts — a complete story told in action alone, no narration, no dialogue.",
    example: "“A scruffy terrier guards his owner’s umbrella through a downpour.”",
    research: "original",
  },
  horror: {
    blurb: "Original short horror — dread built from one wrong detail, never a jump scare.",
    example: "“Dryer 12 has been running for eleven years.”",
    research: "original",
  },
  wisdom: {
    blurb: "Reflective, quietly delivered pieces on how to think and live. Calm, not shouty.",
    example: "“The Stoics had a word for the thing you're feeling at 3am.”",
    research: "sourced",
  },
  finance: {
    blurb: "Money and business explained with the actual numbers, not vague advice.",
    example: "“His best trade ever cost him four million dollars.”",
    research: "sourced",
  },
  fitness: {
    blurb: "Training and discipline, delivered direct. No supplements, no shortcuts.",
    example: "“You are not sore because it worked.”",
    research: "sourced",
  },
  science: {
    blurb: "One surprising mechanism per video, built from something you already know.",
    example: "“A stuck bit broke Voyager 1 from 15 billion miles away.”",
    research: "sourced",
  },
  history: {
    blurb: "Documented events and mythology, told with a narrator's weight.",
    example: "“Four hundred people danced until they died.”",
    research: "sourced",
  },
  comedy: {
    blurb: "Dry observational bits about the small absurd things everyone recognises.",
    example: "“The specific panic of a half-wave at forty feet.”",
    research: "original",
  },
  food: {
    blurb: "Cooking and food culture — warm, sensory, close on the hands and the pan.",
    example: "“The reason your garlic turns bitter is temperature, not timing.”",
    research: "original",
  },
  travel: {
    blurb: "Places and the cultures in them, shot like a memory rather than a brochure.",
    example: "“The village in Norway where the sun doesn't rise for two months.”",
    research: "original",
  },
  gaming: {
    blurb: "Game lore and history for people who already play — no explaining the basics.",
    example: "“The NPC that has been walking to the same door since 2011.”",
    research: "original",
  },
};

export type Niche = {
  slug: string;
  label: string;
} & NicheCopy;

/**
 * Every shipped niche, in the product's own order.
 *
 * Derived from PRESET_CHANNELS on purpose. A niche added to the
 * dashboard but not described here still appears, with placeholder copy
 * — visible and obviously wrong, which gets fixed. The alternative
 * (hand-listing them here) fails the other way: the niche quietly never
 * appears on the site and nobody notices for months.
 */
export const NICHES: Niche[] = PRESET_CHANNELS.map((p) => {
  const copy = COPY[p.name];
  return {
    slug: p.name,
    label: p.label,
    blurb: copy?.blurb ?? "Description coming soon.",
    example: copy?.example ?? "",
    research: copy?.research ?? "original",
  };
});

/** Count shown in headings so the number can never drift from the list. */
export const NICHE_COUNT = NICHES.length;
