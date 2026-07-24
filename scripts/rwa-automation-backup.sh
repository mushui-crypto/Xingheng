#!/bin/sh
set -eu

compose_env="${COMPOSE_ENV_FILE:-.env.production}"

restart_api() {
  docker compose --env-file "$compose_env" up -d api
  docker compose --env-file "$compose_env" up -d web
}

docker compose --env-file "$compose_env" stop api
trap restart_api EXIT HUP INT TERM
docker compose --env-file "$compose_env" --profile rwa-automation-ops run --rm --no-deps rwa-automation-backup
trap - EXIT HUP INT TERM
restart_api
