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
HEALTH_POLL_MAX="${HEALTH_POLL_MAX:-36}"   # x5s  = 3 min grace

# Core containers that must all be up and settled before the site can
# be considered live.
CORE_RE='^(dashboard|caddy|pocketbase|minio)-'
# How long every core container must have been running before we start
# probing. Coolify brings containers up in waves, and a PocketBase
# migration can cascade a restart through depends_on well after the
# first one is answering.
STABLE_SECONDS="${STABLE_SECONDS:-25}"
# Consecutive good probes required. A single 200 is not proof the
# deploy landed — it can arrive in the gap before a restart, which is
# exactly how a previous run reported success while the site was about
# to go down for several minutes.
NEED_CONSECUTIVE="${NEED_CONSECUTIVE:-3}"

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
# Compile errors arrive on stdout inside the buildkit stream, not on
# stderr — filtering on type=='stderr' missed them entirely and the
# dump was useless. Match on content instead, and prefer the lines
# around a TypeScript/Next failure over the Laravel stack trace.
NEEDLES = ('type error', 'failed to compile', 'failed to type check',
           'error:', 'cannot find', 'module not found', 'syntaxerror',
           'build worker exited')
NOISE   = ('executecommandwithprocess', 'illuminate\\\\', 'app\\\\jobs\\\\',
           'stack trace', '#0 ', '#1 ', '#2 ', '#3 ', '#4 ')
hits = []
for e in entries:
    out = e.get('output','') or ''
    low = out.lower()
    if any(n in low for n in NOISE):
        continue
    if any(n in low for n in NEEDLES) or e.get('type') == 'stderr':
        hits.append(out)
for out in (hits[-25:] if hits else []):
    print(out)
if not hits:
    print('(no matching lines — dumping last 20 build-log entries)')
    for e in entries[-20:]:
        print(e.get('output',''))
"
  exit 1
fi

if [ "$STATUS" != "finished" ]; then
  say "TIMED OUT waiting for the build (still in_progress after $((DEPLOY_POLL_MAX*10))s)"
  exit 1
fi

say "build finished — waiting for the stack to settle"

# ── 3. Wait for container uptime to stabilise ────────────────────
# Probing immediately is unreliable: Coolify starts containers in
# waves, and PocketBase applying a migration restarts and takes its
# depends_on dependents with it. An earlier version of this script
# probed once, got a 200 five seconds in, and reported success — then
# the stack restarted a minute later and the site was unreachable
# until someone noticed. Wait until nothing has restarted recently.
youngest_core_uptime() {
  local now min age started c
  now=$(date -u +%s)
  min=999999
  for c in $(sudo docker ps --format '{{.Names}}' | grep -E "$CORE_RE"); do
    started=$(sudo docker inspect -f '{{.State.StartedAt}}' "$c" 2>/dev/null) || continue
    age=$(( now - $(date -u -d "$started" +%s 2>/dev/null || echo "$now") ))
    [ "$age" -lt "$min" ] && min=$age
  done
  echo "$min"
}

core_count() { sudo docker ps --format '{{.Names}}' | grep -cE "$CORE_RE"; }

for i in $(seq 1 40); do          # up to ~200s
  UP=$(youngest_core_uptime)
  N=$(core_count)
  if [ "$N" -ge 4 ] && [ "$UP" -ge "$STABLE_SECONDS" ]; then
    say "stack settled ($N core containers, youngest up ${UP}s)"
    break
  fi
  [ $((i % 4)) -eq 0 ] && say "  waiting… $N core up, youngest ${UP}s"
  sleep 5
done

# ── 4. Sustained health probe ────────────────────────────────────
# No manual network surgery — Traefik re-syncs from Docker events on
# its own. This only waits for that, and insists the result holds.
probe() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null
}
ok_code() { case "$1" in 200|302|307) return 0 ;; *) return 1 ;; esac; }

STREAK=0
SAW_OK=0
NUDGED=0
for i in $(seq 1 "$HEALTH_POLL_MAX"); do
  CODE=$(probe)
  if ok_code "$CODE"; then
    STREAK=$((STREAK + 1))
    SAW_OK=1
    if [ "$STREAK" -ge "$NEED_CONSECUTIVE" ]; then
      say "healthy — $STREAK consecutive OK (HTTP $CODE) after $((i*5))s"
      exit 0
    fi
  else
    # Dropping back to failing AFTER a success is the signature of the
    # route being lost to a restart. That is precisely when the proxy
    # needs re-syncing, so nudge here rather than on a fixed timer.
    if [ "$SAW_OK" -eq 1 ] && [ "$NUDGED" -eq 0 ]; then
      say "was healthy, now HTTP $CODE — route dropped, nudging coolify-proxy"
      sudo docker restart coolify-proxy >/dev/null 2>&1
      NUDGED=1
    elif [ "$i" -eq $((HEALTH_POLL_MAX / 2)) ] && [ "$NUDGED" -eq 0 ]; then
      say "still HTTP $CODE at $((i*5))s — nudging coolify-proxy once"
      sudo docker restart coolify-proxy >/dev/null 2>&1
      NUDGED=1
    fi
    STREAK=0
  fi
  sleep 5
done

say "UNHEALTHY — last probe returned HTTP $(probe)"
say "containers:"
sudo docker ps --format '  {{.Names}}  {{.Status}}' | grep -E 'dashboard|caddy|pocketbase|proxy'
exit 1
