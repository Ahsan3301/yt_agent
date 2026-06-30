# Custom Pocketbase image with our schema migrations baked in.
#
# Same reason as the Caddy image: Coolify doesn't sync the migrations
# directory to its runtime app dir, so we build them in.
#
# The base image (muchobien/pocketbase) is multi-arch and includes
# the pocketbase binary at /usr/local/bin/pocketbase. We just add our
# migration files at the standard /pb_migrations location and rely on
# Pocketbase's auto-apply-on-boot behaviour.

FROM ghcr.io/muchobien/pocketbase:latest
# pb_migrations/ is the build-context root (./coolify/pocketbase/).
COPY pb_migrations /pb_migrations
