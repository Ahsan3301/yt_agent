# Custom Caddy image with the Caddyfile baked in.
#
# Why not a volume bind-mount: Coolify only syncs the compose file to
# its runtime app directory, NOT the rest of the repo. A bind-mount
# referencing ./coolify/Caddyfile finds an auto-created empty
# directory at runtime, which mounts over /etc/caddy/Caddyfile (a
# file) and Docker errors with "not a directory".
#
# Solution: build a Caddy image that already contains the config.
# Coolify-friendly — the only artefact at runtime is the compose
# stanza, which references this built image.

FROM caddy:2-alpine
# Caddyfile lives in the parent build-context directory (coolify/).
# Compose's `context: ./coolify/caddy` means we need to copy it from
# the right relative path — see docker-compose.yml's build stanza.
COPY Caddyfile /etc/caddy/Caddyfile
