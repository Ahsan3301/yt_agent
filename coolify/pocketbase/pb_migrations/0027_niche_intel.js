/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0027 — accumulated niche intelligence.
 *
 * The YouTube key was doing two narrow jobs: three competitor titles at
 * script time, and view counts afterwards. About 1,700 of a 10,000/day
 * quota. Everything else the API knows about a niche — what is ranking
 * now, which tags the winners share, when they publish — was thrown
 * away the moment a render finished.
 *
 * This table is the memory. A daily sweep pulls the top-performing
 * recent videos per niche and MERGES the findings into the row rather
 * than replacing it, so the picture sharpens over weeks instead of
 * being re-guessed from one 50-video snapshot every day.
 *
 * Accumulation is the whole point. A single sweep of a niche produced
 * an "hour 09:00 is best" reading backed by exactly ONE video, next to
 * an hour with five videos and a lower median. Ranking that raw is how
 * you end up scheduling a channel around a fluke. Only pooled counts
 * across many days can carry that weight, and the sample size is stored
 * alongside every figure so nothing downstream can quietly treat thin
 * evidence as settled.
 *
 *   niche              the channel niche this describes
 *   hour_views         JSON {hour: {n, total_views}} accumulated
 *   tag_counts         JSON {tag: count} accumulated
 *   title_patterns     JSON aggregate stats over winning titles
 *   sample_size        total videos observed across all sweeps
 *   last_swept_at      unix seconds
 */
migrate((app) => {
  function ensure(name, schemaFn) {
    try {
      const existing = app.findCollectionByNameOrId(name);
      if (existing) { console.log(`[pb-migrate] ${name}: exists, skipping`); return; }
    } catch (_e) { /* create */ }
    app.save(schemaFn());
    console.log(`[pb-migrate] ${name}: created`);
  }

  const ADMIN_ONLY = null;

  ensure("niche_intel", () => new Collection({
    name: "niche_intel",
    type: "base",
    fields: [
      { name: "niche",          type: "text",   max: 60, required: true },
      { name: "hour_views",     type: "json"   },
      { name: "tag_counts",     type: "json"   },
      { name: "title_patterns", type: "json"   },
      { name: "sample_size",    type: "number" },
      { name: "sweeps",         type: "number" },
      { name: "last_swept_at",  type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_niche_intel_niche ON niche_intel (niche)",
    ],
    listRule:   ADMIN_ONLY,
    viewRule:   ADMIN_ONLY,
    createRule: ADMIN_ONLY,
    updateRule: ADMIN_ONLY,
    deleteRule: ADMIN_ONLY,
  }));

  console.log("[pb-migrate] 0027_niche_intel: done");
}, (app) => { /* additive-only */ });
