#!/bin/sh
set -eu

backup_name="${1:-}"
case "$backup_name" in
  rwa-automation-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.rwa.enc.json) ;;
  *) echo "usage: $0 rwa-automation-YYYYMMDDTHHMMSSZ.rwa.enc.json" >&2; exit 2 ;;
esac

if [ "${RWA_AUTOMATION_RESTORE_VALIDATE_ONLY:-false}" = "true" ]; then
  exit 0
fi

compose_env="${COMPOSE_ENV_FILE:-.env.production}"

restart_api() {
  docker compose --env-file "$compose_env" up -d api
  docker compose --env-file "$compose_env" up -d web
}

docker compose --env-file "$compose_env" stop api
trap restart_api EXIT HUP INT TERM
docker compose --env-file "$compose_env" --profile rwa-automation-ops run --rm --no-deps \
  -e RWA_AUTOMATION_RESTORE_FILE="$backup_name" rwa-automation-restore
trap - EXIT HUP INT TERM
restart_api
