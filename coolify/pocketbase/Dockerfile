# Custom Pocketbase image with our schema migrations baked in.
#
# Same reason as the Caddy image: Coolify doesn't sync the migrations
# directory to its runtime app dir, so we build them in.
#
# The base image (muchobien/pocketbase) is multi-arch and includes
# the pocketbase binary at /usr/local/bin/pocketbase. We just add our
# migration files at the standard /pb_migrations location and rely on
# Pocketbase's auto-apply-on-boot behaviour.

# Pinned to v0.22.x because our migrations use the legacy `Dao`-style
# JSVM API (`new Dao(db).findCollectionByNameOrId(...)`). Pocketbase
# v0.23+ removed `Dao` in favor of an `$app`-based API. We can migrate
# the schema file later; for now pinning is the lowest-risk fix.
FROM ghcr.io/muchobien/pocketbase:0.22.21
# pb_migrations/ is the build-context root (./coolify/pocketbase/).
COPY pb_migrations /pb_migrations
