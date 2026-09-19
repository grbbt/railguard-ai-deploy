#!/bin/sh
set -eu

fail() { printf '%s\n' "Refusing to start: $1" >&2; exit 1; }

# Restrict values used as Caddyfile tokens; empty/default config must fail closed.
newline='
'
case "${DOMAIN:-}${JUDGE_USER:-}${JUDGE_PASSWORD_HASH:-}" in
    *"$newline"*) fail 'Access configuration values must each be a single line.' ;;
esac
printf '%s\n' "${DOMAIN:-}" | grep -Eq '^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$' \
    || fail 'DOMAIN must be your public DNS hostname, without scheme/path/port.'
domain_lower=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
case "$domain_lower" in
    example.com|*.example.com|example.org|*.example.org|example.net|*.example.net|*replace*|*changeme*)
        fail 'Replace the example DOMAIN with a hostname you control.' ;;
esac
printf '%s\n' "${JUDGE_USER:-}" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$' \
    || fail 'JUDGE_USER must be 1-64 letters/digits or . _ @ - characters.'
case "$JUDGE_USER" in
    replace*|REPLACE*|changeme*|CHANGEME*) fail 'Replace the example JUDGE_USER.' ;;
esac
# bcrypt is kept in a single-quoted Compose .env value; never double the dollars.
printf '%s\n' "${JUDGE_PASSWORD_HASH:-}" | grep -Eq '^[$]2[aby][$](0[4-9]|[12][0-9]|3[01])[$][./a-zA-Z0-9]{53}$' \
    || fail 'JUDGE_PASSWORD_HASH must be a valid bcrypt hash from caddy hash-password.'

exec "$@"
