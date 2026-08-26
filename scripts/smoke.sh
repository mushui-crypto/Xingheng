#!/bin/sh
set -eu

base_url="${1:-https://${DOMAIN:-}}"
[ -n "$base_url" ] || { echo "usage: $0 https://trade.example.com" >&2; exit 2; }
case "$base_url" in
  https://[A-Za-z0-9]*.[A-Za-z0-9.-]*) ;;
  *) echo "smoke URL must be a fixed HTTPS origin without credentials or path" >&2; exit 78 ;;
esac
case "${base_url#https://}" in
  *[:/@?#]*|*..*|.*|*.) echo "smoke URL is invalid" >&2; exit 78 ;;
esac

docker compose -p xingheng run --rm --no-deps \
  -e "SMOKE_BASE_URL=$base_url" \
  api node /app/scripts/deployment-smoke.mjs
