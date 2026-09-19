#!/usr/bin/env bash
# Sourced by the deployment commands. Never source a credential .env as shell code.
set -euo pipefail
DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$DEPLOY_DIR/../.." && pwd)
ENV_FILE="$DEPLOY_DIR/.env"

command -v docker >/dev/null 2>&1 || { echo 'Install Docker Engine and the Compose plugin first; see the deployment guide.' >&2; exit 1; }
docker compose version >/dev/null
test -f "$ENV_FILE" || { echo 'Create deploy/oracle/.env from .env.example on this server first.' >&2; exit 1; }
# Stable project name preserves named volumes when extracting an updated bundle.
compose() { docker compose --project-name railguard-oracle --env-file "$ENV_FILE" -f "$DEPLOY_DIR/compose.yaml" "$@"; }
# Quiet validation avoids printing resolved credentials to a terminal/log.
compose config --quiet
