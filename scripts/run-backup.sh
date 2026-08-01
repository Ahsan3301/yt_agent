#!/usr/bin/env bash
# Nightly backup runner. Installed in the VPS host crontab:
#
#   15 3 * * * /opt/yven/run-backup.sh >> /var/log/yven-backup.log 2>&1
#
# Why a wrapper rather than baking the script into the image: Coolify
# replaces the dashboard container on every deploy, so anything copied
# into it is lost. This re-copies backup.js into whichever container is
# currently running, then executes it there. Keeping the payload out of
# the image also means changing backup policy needs no redeploy.
set -uo pipefail

SCRIPT_SRC="${SCRIPT_SRC:-/opt/yven/backup.js}"
LOG_TAG="[yven-backup]"

say() { echo "$LOG_TAG $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

if [ ! -f "$SCRIPT_SRC" ]; then
  say "FATAL: $SCRIPT_SRC missing"
  exit 1
fi

DASH=$(docker ps --format '{{.Names}}' | grep '^dashboard-' | head -1)
if [ -z "$DASH" ]; then
  say "FATAL: no running dashboard container"
  exit 1
fi

# /app/web, not /tmp — Node resolves node_modules by walking up from
# the script's directory, and the SDK lives in /app/web/node_modules.
docker cp "$SCRIPT_SRC" "$DASH":/app/web/backup.js || { say "FATAL: docker cp failed"; exit 1; }

say "running in $DASH"
docker exec -w /app/web "$DASH" node backup.js
RC=$?

# Tidy up so a stale copy can't be executed against a future image.
docker exec "$DASH" rm -f /app/web/backup.js 2>/dev/null || true

if [ $RC -ne 0 ]; then
  say "FAILED rc=$RC"
  # Surface it to the operator rather than dying silently in a log file
  # nobody reads. Reuses the Discord webhook the pipeline already has.
  HOOK=$(docker exec "$DASH" printenv DISCORD_WEBHOOK_URL 2>/dev/null || true)
  if [ -n "$HOOK" ]; then
    curl -sS -m 15 -X POST -H 'Content-Type: application/json' \
      -d "{\"content\":\"⚠️ Yven nightly backup FAILED (rc=$RC) on $(hostname). The database is the only copy — check /var/log/yven-backup.log.\"}" \
      "$HOOK" >/dev/null 2>&1 || true
  fi
  exit $RC
fi

say "OK"
