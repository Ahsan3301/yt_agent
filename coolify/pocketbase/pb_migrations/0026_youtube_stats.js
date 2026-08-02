/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0026 — real YouTube performance data on each run.
 *
 * Two things this unlocks, both currently invisible:
 *
 * 1. Whether a video is doing anything. The platform publishes and then
 *    forgets — nobody could tell that one of the 2026-08-02 uploads had
 *    600 views and 17 likes while its siblings had 0. Without that, no
 *    judgement about titles, niches or timing is grounded in anything.
 *
 * 2. Whether a video is still up. YouTube can flip a video to private,
 *    block it on copyright, or remove it, and none of that produces an
 *    event. Today such a run still reads "published" forever. The
 *    status fields make a removed video visible as removed.
 *
 * Cheap enough to be worth doing often: videos.list returns up to 50
 * ids for ONE quota unit, so the entire back catalogue costs a couple
 * of units per sweep against a 10,000/day budget.
 */
migrate((app) => {
  function addField(collName, field) {
    let coll;
    try { coll = app.findCollectionByNameOrId(collName); }
    catch (_e) {
      console.log(`[pb-migrate] ${collName}: missing — skipping ${field.name}`);
      return;
    }
    if ((coll.fields || []).some((f) => f.name === field.name)) {
      console.log(`[pb-migrate] ${collName}.${field.name}: exists, skipping`);
      return;
    }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collName}.${field.name}: added`);
  }

  addField("runs_index", { name: "view_count",       type: "number" });
  addField("runs_index", { name: "like_count",       type: "number" });
  addField("runs_index", { name: "comment_count",    type: "number" });
  // "public" | "unlisted" | "private" — anything but public on a video
  // we published means something changed on YouTube's side.
  addField("runs_index", { name: "yt_privacy_status", type: "text", max: 20 });
  // "processed" | "uploaded" | "rejected" | "failed" | "deleted".
  // "deleted" is written by us when videos.list omits the id entirely,
  // which is how a removed video presents.
  addField("runs_index", { name: "yt_upload_status",  type: "text", max: 20 });
  addField("runs_index", { name: "stats_checked_at",  type: "number" });

  console.log("[pb-migrate] 0026_youtube_stats: done");
}, (app) => { /* additive-only */ });
