# Custom Pocketbase image with our schema migrations baked in.
#
# Same reason as the Caddy image: Coolify doesn't sync the migrations
# directory to its runtime app dir, so we build them in.
#
# Migration uses the v0.23+ API (new Collection({fields}), app.save(),
# app.findCollectionByNameOrId, etc.). Older v0.22 used `Dao` +
# `schema:` which is incompatible. So we use `latest`.
FROM ghcr.io/muchobien/pocketbase:latest
# pb_migrations/ is the build-context root (./coolify/pocketbase/).
COPY pb_migrations /pb_migrations
