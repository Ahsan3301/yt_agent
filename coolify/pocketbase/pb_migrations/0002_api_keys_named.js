/// <reference path="../pb_data/types.d.ts" />

/**
 * Migration 0002 — give api_keys a queryable name field.
 *
 * Why: the dashboard's /api/keys route treated the document id as the
 * key name (Firestore-style). Pocketbase ids must be 15-char [a-z0-9]+,
 * so the wrapper was hashing names like "NVIDIA_NIM_API_KEY" to a
 * deterministic 15-char id on write. Writes succeeded, but reads
 * looked up the original name and saw `set: false` because the doc
 * ids in the result set were the HASHES, not the names.
 *
 * Fix: add a `key_name` text field + unique index. The route now
 * reads/writes via `where("key_name", "==", x)` instead of relying on
 * doc-id identity. PB doc ids become opaque storage details.
 */
migrate((app) => {
  const col = app.findCollectionByNameOrId("api_keys");

  // Idempotency — re-running the migration is a no-op.
  if (col.fields.find((f) => f.name === "key_name")) return;

  col.fields.add(new Field({
    name: "key_name",
    type: "text",
    max: 80,
    required: false,
  }));

  // Unique by key_name so two saves of the same key collapse into one row.
  const existing = col.indexes || [];
  if (!existing.some((i) => i.includes("idx_api_keys_name"))) {
    col.indexes = [
      ...existing,
      "CREATE UNIQUE INDEX idx_api_keys_name ON api_keys (key_name)",
    ];
  }

  app.save(col);
}, (app) => {
  // Down — drop the field.
  try {
    const col = app.findCollectionByNameOrId("api_keys");
    const f = col.fields.find((f) => f.name === "key_name");
    if (f) col.fields.remove(f.id);
    col.indexes = (col.indexes || []).filter((i) => !i.includes("idx_api_keys_name"));
    app.save(col);
  } catch (_) {}
});
