#!/bin/sh
set -eu

[ "${1:-}" = "rollback" ] || { echo "usage: $0 rollback" >&2; exit 2; }
compose_env="${COMPOSE_ENV_FILE:-.env.production}"

restart_api() {
  docker compose --env-file "$compose_env" up -d api
  docker compose --env-file "$compose_env" up -d web
}

docker compose --env-file "$compose_env" stop api
trap restart_api EXIT HUP INT TERM
docker compose --env-file "$compose_env" --profile rwa-automation-ops run --rm --no-deps \
  rwa-automation-restore flock -n -x /app/rwa-automation-lock/operation.lock \
  node dist-server/operations/rwa-automation-backup.js rollback
trap - EXIT HUP INT TERM
restart_api
