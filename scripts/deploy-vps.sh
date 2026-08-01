#!/usr/bin/env bash
# Deploy yt-agent to the Coolify VPS.
#
# Run from a workstation:
#   ssh -i <key> ubuntu@<vps> bash -s < scripts/deploy-vps.sh
#   ssh -i <key> ubuntu@<vps> FORCE_REBUILD=1 bash -s < scripts/deploy-vps.sh
#
# ── Why this script exists ────────────────────────────────────────
# Earlier deploys ran a manual "hot swap":
#
#   docker network disconnect <uuid-net> <dashboard>
#   docker network connect --alias dashboard <uuid-net> <dashboard>
#   docker restart <caddy>; docker restart coolify-proxy   # x3
#
# That was cargo-cult and actively harmful. Verified 2026-08-01:
# Coolify's compose already attaches the dashboard container to
# <uuid>_yt_agent_net with the alias `dashboard` (derived from the
# compose service name), and caddy — which is on both that network
# AND the shared `coolify` network where Traefik lives — resolves
# `dashboard:3000` fine with zero manual intervention.
#
# The disconnect/reconnect churned Docker's network state mid-deploy,
# which made Traefik drop its route to caddy. That is what produced
# the recurring "HTTP 000 until you restart coolify-proxy 2-3 times"
# symptom. Removing the swap removes the cause.
#
# What remains: queue the deploy, wait for it, then health-probe.
# Traefik re-syncs from Docker events on its own within a few
# seconds. We only nudge coolify-proxy if the probe is still failing
# after the grace period — and even then, once, not three times.
set -uo pipefail

APP_UUID="${APP_UUID:-mhbbo4wuiineahv4comdjh5k}"
APP_ID="${APP_ID:-1}"
HEALTH_URL="${HEALTH_URL:-https://yt-agent.thyker.online/login}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"

DEPLOY_POLL_MAX="${DEPLOY_POLL_MAX:-90}"   # x10s = 15 min ceiling
HEALTH_POLL_MAX="${HEALTH_POLL_MAX:-18}"   # x5s  = 90s grace

say() { echo "[deploy] $*"; }

# ── 1. Queue the deployment ──────────────────────────────────────
FORCE_PHP=$([ "$FORCE_REBUILD" = "1" ] && echo "true" || echo "false")
say "queueing deployment (force_rebuild=$FORCE_PHP)"
sudo docker exec coolify php artisan tinker --execute="
\$app = App\Models\Application::where('uuid', '$APP_UUID')->first();
queue_application_deployment(
  application: \$app,
  deployment_uuid: (string) Illuminate\Support\Str::uuid(),
  force_rebuild: $FORCE_PHP,
  no_questions_asked: true,
  is_api: true
);
echo \"queued\n\";
" 2>&1 | tail -2

# ── 2. Wait for the build ────────────────────────────────────────
LAST=""
STATUS=""
for i in $(seq 1 "$DEPLOY_POLL_MAX"); do
  sleep 10
  ROW=$(sudo docker exec coolify-db psql -U coolify -d coolify -t -A \
        -c "SELECT id||'|'||status FROM application_deployment_queues
            WHERE application_id='$APP_ID' ORDER BY id DESC LIMIT 1;" 2>&1)
  [ "$ROW" != "$LAST" ] && { say "t+$((i*10))s  $ROW"; LAST="$ROW"; }
  case "$ROW" in
    *finished*|*success*) STATUS="finished"; break ;;
    *failed*)             STATUS="failed";   break ;;
  esac
done

if [ "$STATUS" = "failed" ]; then
  say "BUILD FAILED — dumping the tail of the build log"
  sudo docker exec coolify-db psql -U coolify -d coolify -t -A \
    -c "SELECT logs FROM application_deployment_queues
        WHERE application_id='$APP_ID' ORDER BY id DESC LIMIT 1;" 2>/dev/null \
  | python3 -c "
import sys, json
try:
    entries = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
bad = [e for e in entries
       if e.get('type') == 'stderr'
       or 'error' in e.get('output','').lower()
       or 'failed'  in e.get('output','').lower()]
for e in bad[-12:]:
    print('---'); print(e.get('output',''))
"
  exit 1
fi

if [ "$STATUS" != "finished" ]; then
  say "TIMED OUT waiting for the build (still in_progress after $((DEPLOY_POLL_MAX*10))s)"
  exit 1
fi

say "build finished — waiting for Traefik to pick up the new container"

# ── 3. Health probe ──────────────────────────────────────────────
# NO manual network surgery. Traefik watches Docker events and
# re-syncs on its own; this loop just waits for that to land.
probe() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null
}

NUDGED=0
for i in $(seq 1 "$HEALTH_POLL_MAX"); do
  CODE=$(probe)
  if [ "$CODE" = "200" ] || [ "$CODE" = "302" ] || [ "$CODE" = "307" ]; then
    say "healthy after $((i*5))s — HTTP $CODE"
    exit 0
  fi
  # Halfway through the grace period, give Traefik exactly one nudge.
  if [ "$i" -eq $((HEALTH_POLL_MAX / 2)) ] && [ "$NUDGED" -eq 0 ]; then
    say "still HTTP $CODE at $((i*5))s — nudging coolify-proxy once"
    sudo docker restart coolify-proxy >/dev/null 2>&1
    NUDGED=1
  fi
  sleep 5
done

say "UNHEALTHY — last probe returned HTTP $(probe)"
say "containers:"
sudo docker ps --format '  {{.Names}}  {{.Status}}' | grep -E 'dashboard|caddy|proxy'
exit 1
