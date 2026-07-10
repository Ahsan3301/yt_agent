/// <reference path="../pb_data/types.d.ts" />
/**
 * Migration 0003 — per-channel worker priority + Oracle unlock.
 *
 * Adds two fields on each of `channels` and `jobs`:
 *   allowed_workers       json   — ordered priority list of
 *                                  ["kaggle","colab","oracle"].
 *   oracle_password_hash  text   — scrypt$salt$hash. Write-only;
 *                                  never returned to the client (the
 *                                  /api/channels GET route projects
 *                                  has_oracle_password instead).
 *
 * Idempotent: if a field already exists, skip.
 */
migrate((app) => {
  function addField(collectionName, field) {
    let coll;
    try {
      coll = app.findCollectionByNameOrId(collectionName);
    } catch (_e) {
      console.log(`[pb-migrate] ${collectionName}: collection missing — skipping ${field.name}`);
      return;
    }
    const has = (coll.fields || []).some((f) => f.name === field.name);
    if (has) {
      console.log(`[pb-migrate] ${collectionName}.${field.name}: exists, skipping`);
      return;
    }
    coll.fields.add(new Field(field));
    app.save(coll);
    console.log(`[pb-migrate] ${collectionName}.${field.name}: added`);
  }

  // channels
  addField("channels", { name: "allowed_workers",      type: "json", maxSize: 500 });
  addField("channels", { name: "oracle_password_hash", type: "text", max: 200 });

  // jobs — same fields propagated at submit-time by the scheduled-render
  // and per-channel Run-Now routes.
  addField("jobs",     { name: "allowed_workers",      type: "json", maxSize: 500 });
  addField("jobs",     { name: "oracle_password_hash", type: "text", max: 200 });
}, (app) => {
  // no down — PB v0.23+ doesn't support field-drop through this API
  // safely on populated tables. Manual SQL if a rollback is ever needed.
});
