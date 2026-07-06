#!/bin/sh
set -eu

base_url="${1:-https://${DOMAIN:-}}"
[ -n "$base_url" ] || { echo "usage: $0 https://trade.example.com" >&2; exit 2; }

docker compose --env-file "${COMPOSE_ENV_FILE:-.env.production}" run --rm --no-deps \
  -e "SMOKE_BASE_URL=$base_url" \
  --entrypoint node api /app/scripts/deployment-smoke.mjs
