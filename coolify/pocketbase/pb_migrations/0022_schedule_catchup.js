/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0022 — schedule catch-up marker.
 *
 * The scheduler was edge-triggered: a channel fired only when the
 * hourly cron tick landed exactly on its configured hour. busybox
 * crond has no catch-up and every deploy restarts the cron sidecar,
 * so any channel whose hour fell inside a deploy window silently lost
 * that day's video — no error, no alert, nothing in the queue.
 * Observed live: Nightflinch (hour 20) lost 2026-08-01 to a sidecar
 * that was down from 20:44.
 *
 * `last_scheduled_day` turns that into a level-triggered check: fire
 * when the channel is due AND hasn't already run today. A missed tick
 * then self-heals on the next hourly one — an hour late rather than a
 * day lost — and a restart mid-hour can no longer double-queue.
 *
 *   last_scheduled_day  "YYYY-MM-DD" in the channel's own timezone
 *                       (not UTC — the due check is timezone-aware,
 *                       so the marker has to agree with it or a
 *                       channel near midnight would double-fire).
 *                       Absent = never run; treated as due.
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

  // 10 chars is exactly "YYYY-MM-DD".
  addField("channels", { name: "last_scheduled_day", type: "text", max: 10 });

  // Publish-retry bookkeeping for /api/maintenance/retry-publish.
  // Without these the sweep cannot bound its attempts, and an
  // un-publishable video would be retried every 20 minutes forever.
  addField("jobs", { name: "publish_retry_count",   type: "number" });
  addField("jobs", { name: "last_publish_retry_at", type: "number" });

  console.log("[pb-migrate] 0022_schedule_catchup: done");
}, (app) => { /* additive-only */ });
