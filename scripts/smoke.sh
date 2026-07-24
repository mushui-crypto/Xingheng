#!/bin/sh
set -eu

base_url="${1:-https://${DOMAIN:-}}"
[ -n "$base_url" ] || { echo "usage: $0 https://trade.example.com" >&2; exit 2; }
compose_env="${COMPOSE_ENV_FILE:-.env.production}"
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null

production_compose run --rm --no-deps \
  -e "SMOKE_BASE_URL=$base_url" \
  api node /app/scripts/deployment-smoke.mjs
