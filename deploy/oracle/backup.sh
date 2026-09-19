#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
umask 077
BACKUP_DIR="${1:-$DEPLOY_DIR/backups}"
mkdir -p -- "$BACKUP_DIR"
BACKUP_DIR=$(cd -- "$BACKUP_DIR" && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/runtime-$stamp.tar.gz"
test ! -e "$target" && test ! -e "$target.partial" || { echo 'A backup with this timestamp already exists; retry later.' >&2; exit 1; }
running=$(compose ps --status running --services backend)
test "$running" = backend || { echo 'Backend must be running before taking this backup.' >&2; exit 1; }
restart_backend() { compose start backend >/dev/null || echo 'Backend restart failed; run the start command and inspect logs.' >&2; }
# Stopping the sole writer makes SQLite and saved-job copies consistent. Active
# jobs are interrupted and will be marked failed on restart; choose an idle time.
trap restart_backend EXIT
compose stop --timeout 90 backend
compose run --rm --no-deps -T backend python -c "import sys, tarfile; archive=tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz'); archive.add('/app/data/runtime', arcname='runtime'); archive.close()" > "$target.partial"
mv -- "$target.partial" "$target"
printf 'Runtime backup saved: %s\n' "$target"
echo 'This contains uploaded recordings/results. Store it privately. Models and TLS volumes are separate.'
