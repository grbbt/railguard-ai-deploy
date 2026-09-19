#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

test -d "$PROJECT_ROOT/data/ps3" || { echo 'The bundle must contain data/ps3, even when no Test examples are included.' >&2; exit 1; }
echo 'Checking proxy configuration and required access credentials...'
compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
echo 'Building target-platform application images...'
compose build --pull backend frontend
echo 'Checking trusted model artifacts before startup...'
samples=(
    'Door/Test.csv'
    'ACV/Test/acv_test_case.xlsx'
    'Rail_Corrugation/Test/Test1.csv'
    'SHM/Test/test01.csv'
)
has_samples=true
for sample in "${samples[@]}"; do
    test -f "$PROJECT_ROOT/data/ps3/PS3/02_Datasets/$sample" || has_samples=false
done
if "$has_samples"; then
    compose run --rm --no-deps backend python scripts/check_deployment_models.py --inference --reference deploy/oracle/model-reference.json
else
    compose run --rm --no-deps backend python scripts/check_deployment_models.py
    echo 'Test samples are incomplete/omitted: artifact loading passed; inference parity is unverified. Use --include-test-data when packaging to enable that check.'
fi
echo 'Starting services; existing runtime and certificate volumes are retained...'
compose up --detach --wait --wait-timeout 300
compose ps
echo 'Run bash deploy/oracle/verify.sh to check public authentication and model inference.'
