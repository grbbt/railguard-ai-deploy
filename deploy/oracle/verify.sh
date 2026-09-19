#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
command -v curl >/dev/null || { echo 'Install curl before verifying the public endpoint.' >&2; exit 1; }

compose ps
compose exec -T backend python -c "import json, urllib.request; result=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=10)); assert result['status']=='ok'; print('Backend health: ok')"
compose exec -T frontend node -e "fetch('http://127.0.0.1:3000').then(r=>{if(!r.ok)process.exit(1);console.log('Frontend health: ok')}).catch(()=>process.exit(1))"
compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
DOMAIN_VALUE=$(compose exec -T caddy printenv DOMAIN | tr -d '\r')
JUDGE_VALUE=$(compose exec -T caddy printenv JUDGE_USER | tr -d '\r')
for route in / /api/health /api/ps3/status; do
    status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 15 --max-time 30 "https://$DOMAIN_VALUE$route")
    test "$status" = 401 || { echo "Authentication gate failed: $route returned $status, expected 401." >&2; exit 1; }
done
echo 'Unauthenticated pages and APIs return 401. Enter the judge password for the authenticated health check:'
# curl prompts securely because only the username is passed; no password in argv.
curl --fail --show-error --silent --user "$JUDGE_VALUE" --connect-timeout 15 --max-time 30 "https://$DOMAIN_VALUE/api/health"
printf '\n'
echo 'Checking all four model loads and one supplied Test inference per subsystem...'
compose exec -T backend python scripts/check_deployment_models.py --inference --reference deploy/oracle/model-reference.json
echo 'Recent service logs (inspect before sharing):'
compose logs --tail 40 backend frontend caddy
echo 'Verification passed. Complete the browser upload/export/restart checks in the guide.'
