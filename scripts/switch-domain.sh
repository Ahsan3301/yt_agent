#!/usr/bin/env bash
# Move the deployment to a new public domain, in one step.
#
#   ssh -i <key> ubuntu@<vps> NEW_DOMAIN=yven.io bash -s < scripts/switch-domain.sh
#   ssh -i <key> ubuntu@<vps> NEW_DOMAIN=yven.io DRY_RUN=1 bash -s < scripts/switch-domain.sh
#
# ── Why this is a script and not a checklist ──────────────────────
# The domain appears in five places that must agree, and getting them
# out of step fails in ways that are slow to diagnose:
#
#   1. SERVICE_FQDN_CADDY / DOMAIN in the Coolify app .env  — what
#      Traefik routes and what the cert is issued for.
#   2. NEXT_PUBLIC_S3_PUBLIC_BASE in the same .env          — baked into
#      the frontend bundle at BUILD time, so it needs a redeploy, not
#      just a restart.
#   3. storage_providers.public_base (MinIO + any mirror)   — the URL
#      written into every future video row.
#   4. platform_config.PUBLIC_BASE_URL                      — used to
#      build absolute links in notifications and OAuth callbacks.
#   5. Coolify's own FQDN record                            — without
#      this Traefik never learns the new host and the site 404s.
#
# ── The one thing this script cannot do ───────────────────────────
# DNS. The A record must already point at this server BEFORE running,
# or Let's Encrypt's HTTP-01 challenge lands somewhere else, cert
# issuance fails, and the site loses HTTPS. The preflight below refuses
# to run until that is true — that check is the point of the script.
set -euo pipefail

NEW_DOMAIN="${NEW_DOMAIN:-}"
DRY_RUN="${DRY_RUN:-}"
APP_DIR=/data/coolify/applications/mhbbo4wuiineahv4comdjh5k
ENV_FILE="$APP_DIR/.env"

[ -n "$NEW_DOMAIN" ] || { echo "::error:: set NEW_DOMAIN=example.com"; exit 1; }

say() { echo "[domain] $*"; }
run() { if [ -n "$DRY_RUN" ]; then echo "  DRY: $*"; else eval "$@"; fi; }

# ── Preflight: DNS must point here ────────────────────────────────
MY_IP="$(curl -s -4 --max-time 10 ifconfig.me || true)"
# Ask a public resolver, NOT getent. The local stub cache holds the
# previous A record for the full TTL (measured: 4h on this domain), so
# getent reports the OLD address long after the change is live and this
# preflight would refuse a switch that is perfectly safe. Let's Encrypt
# resolves authoritatively too, so this matches what actually matters.
DNS_IP="$(python3 - "$NEW_DOMAIN" <<'PY' || true
import json, sys, urllib.request
try:
    r = urllib.request.Request(f"https://dns.google/resolve?name={sys.argv[1]}&type=A",
                               headers={"User-Agent": "curl/8"})
    d = json.loads(urllib.request.urlopen(r, timeout=15).read())
    for a in d.get("Answer", []):
        if a.get("type") == 1:
            print(a["data"]); break
except Exception:
    pass
PY
)"
say "server IP : ${MY_IP:-unknown}"
say "$NEW_DOMAIN -> ${DNS_IP:-NOT RESOLVING}"
if [ -z "$DNS_IP" ]; then
  echo "::error:: $NEW_DOMAIN does not resolve. Create the A record first."
  exit 1
fi
if [ "$DNS_IP" != "$MY_IP" ]; then
  echo "::error:: $NEW_DOMAIN points at $DNS_IP but this server is $MY_IP."
  echo "           Switching now would fail cert issuance and drop HTTPS."
  echo "           Repoint the A record, wait for propagation, re-run."
  exit 1
fi
say "DNS preflight OK"

OLD_DOMAIN="$(grep -E '^SERVICE_FQDN_CADDY=' "$ENV_FILE" | cut -d= -f2- || true)"
say "old domain: ${OLD_DOMAIN:-none}  ->  new: $NEW_DOMAIN"
[ "$OLD_DOMAIN" = "$NEW_DOMAIN" ] && { say "already on $NEW_DOMAIN — nothing to do"; exit 0; }

# ── 1+2. Coolify's environment variables (THE source of truth) ────
# NOT the .env file on disk. Coolify regenerates that file from its own
# database on every deploy, so editing it looks like it worked and is
# silently reverted the moment you redeploy — which is exactly what
# happened on the first run of this script: the switch appeared to
# succeed, the deploy reported healthy, and Traefik was still routing
# the old host with its default self-signed cert.
#
# POCKETBASE_ADMIN_EMAIL is deliberately skipped: it is a login
# identity that happens to contain the domain, not a URL. Rewriting it
# would rename the database superuser and lock us out.
if [ -n "$DRY_RUN" ]; then
  say "DRY: would rewrite Coolify env vars containing $OLD_DOMAIN"
else
  docker exec coolify php artisan tinker --execute="
    \$a = \App\Models\Application::where('uuid','mhbbo4wuiineahv4comdjh5k')->first();
    foreach (\$a->environment_variables as \$e) {
      if (\$e->key === 'POCKETBASE_ADMIN_EMAIL') { continue; }
      if (str_contains((string)\$e->value, '${OLD_DOMAIN}')) {
        \$e->value = str_replace('${OLD_DOMAIN}', '${NEW_DOMAIN}', \$e->value);
        \$e->save();
        echo '  env ' . \$e->key . ' -> ' . \$e->value . PHP_EOL;
      }
    }
  " 2>/dev/null | tail -20
fi
say "updated Coolify env vars"

# ── 3+4. database: storage public_base and PUBLIC_BASE_URL ────────
PB=$(docker ps --format '{{.Names}}' | grep pocketbase | head -1)
PBIP=$(docker inspect "$PB" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' | tr ' ' '\n' | grep -v '^$' | head -1)
TOK=$(curl -sS --data "{\"identity\":\"${PB_ADMIN_EMAIL:-admin@yt-agent.thyker.online}\",\"password\":\"${PB_ADMIN_PASSWORD:?set PB_ADMIN_PASSWORD}\"}" \
      -H 'Content-Type: application/json' \
      "http://$PBIP:8090/api/collections/_superusers/auth-with-password" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

if [ -n "$DRY_RUN" ]; then
  say "DRY: would rewrite storage_providers.public_base and PUBLIC_BASE_URL"
else
  OLD="$OLD_DOMAIN" NEW="$NEW_DOMAIN" TOK="$TOK" PBIP="$PBIP" python3 <<'PY'
import json, os, urllib.request
old, new, tok, ip = os.environ["OLD"], os.environ["NEW"], os.environ["TOK"], os.environ["PBIP"]
base = f"http://{ip}:8090/api/collections"

def req(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Authorization": tok, "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r).read() or b"{}")

# Storage: rewrite any field carrying the old host. Existing rows in
# runs_index keep their old absolute URLs on purpose — rewriting those
# would be a bulk mutation of history for a cosmetic gain, and the old
# host may still resolve for a while.
# URL fields only. A blanket "any string containing the old host"
# rewrite also caught R2's `user` field (admin@<old-domain>) on the
# first run — harmless there because S3-kind providers authenticate by
# access key, but it is the kind of scattergun edit that eventually
# rewrites a credential that DOES matter.
URL_FIELDS = ("endpoint", "public_base", "host")
n = 0
for rec in req("GET", f"{base}/storage_providers/records?perPage=50").get("items", []):
    patch = {k: v.replace(old, new) for k, v in rec.items()
             if k in URL_FIELDS and isinstance(v, str) and old in v}
    if patch:
        req("PATCH", f"{base}/storage_providers/records/{rec['id']}", patch)
        print(f"  storage {rec.get('name')}: {', '.join(patch)}")
        n += 1
print(f"  storage rows updated: {n}")

# PUBLIC_BASE_URL — upsert, since it is commonly unset.
want = f"https://{new}"
found = None
for rec in req("GET", f"{base}/platform_config/records?perPage=200").get("items", []):
    if rec.get("key") == "PUBLIC_BASE_URL":
        found = rec
        break
if found:
    req("PATCH", f"{base}/platform_config/records/{found['id']}", {"value": want})
    print(f"  PUBLIC_BASE_URL updated -> {want}")
else:
    req("POST", f"{base}/platform_config/records", {"key": "PUBLIC_BASE_URL", "value": want})
    print(f"  PUBLIC_BASE_URL created -> {want}")
PY
fi

# ── 5. Coolify's FQDN record ──────────────────────────────────────
# Without this Traefik keeps routing the old host and the new one 404s.
if [ -n "$DRY_RUN" ]; then
  say "DRY: would update Coolify application fqdn"
else
  # BOTH fields. `fqdn` is what the UI shows; `docker_compose_domains`
  # is what actually generates the Traefik Host() label for a
  # docker-compose application — and it is per-service, keyed by the
  # service name that owns the ingress ("caddy" here).
  #
  # Setting only fqdn is the trap: the UI reads correct, the deploy
  # reports healthy, and Traefik keeps routing the OLD host with its
  # self-signed default cert, so the new domain answers nothing. That
  # cost two full rebuilds to find. The label is the ground truth —
  # verify it after deploying, not the health check.
  docker exec coolify php artisan tinker --execute="
    \$a = \App\Models\Application::where('uuid','mhbbo4wuiineahv4comdjh5k')->first();
    if (\$a) {
      \$a->fqdn = 'https://${NEW_DOMAIN}';
      \$d = json_decode((string)\$a->docker_compose_domains, true) ?: [];
      foreach (\$d as \$svc => \$_) { \$d[\$svc]['domain'] = 'https://${NEW_DOMAIN}'; }
      if (!\$d) { \$d = ['caddy' => ['domain' => 'https://${NEW_DOMAIN}']]; }
      \$a->docker_compose_domains = json_encode(\$d);
      \$a->save();
      echo 'fqdn + docker_compose_domains set';
    } else { echo 'application not found'; }
  " 2>/dev/null || say "WARNING: could not update Coolify fqdn — set it in the UI"
fi

say ""
say "After redeploying, VERIFY THE LABEL, not the health check:"
say "  docker inspect <caddy-container> --format '{{json .Config.Labels}}' \\"
say "    | tr ',' '\n' | grep 'routers.https-0.*rule'"
say "It must read Host(\`${NEW_DOMAIN}\`). A deploy reports healthy while"
say "still serving the old host, because it probes the old host."
say ""
say "Config done. NOW REDEPLOY — NEXT_PUBLIC_* are compiled into the"
say "frontend bundle, so a restart alone will serve the old value:"
say "  ssh ... bash -s < scripts/deploy-vps.sh"
say ""
say "Then update these by hand (external systems, not ours):"
say "  - Google Cloud Console -> OAuth redirect URI:"
say "      https://${NEW_DOMAIN}/api/youtube/callback"
say "  - GitHub OAuth app callback, if you use the GitHub connect flow"
say "  - GitHub repo variable DASHBOARD_BASE_URL -> https://${NEW_DOMAIN}"
say "    (the Kaggle dispatch workflow reads it to probe needs-worker)"
