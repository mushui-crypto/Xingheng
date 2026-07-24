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
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null

restart_api() {
  production_compose up -d api
  production_compose up -d web
  verify_release_containers
}

production_compose stop api
trap restart_api EXIT HUP INT TERM
production_compose --profile rwa-automation-ops run --rm --no-deps \
  -e RWA_AUTOMATION_RESTORE_FILE="$backup_name" rwa-automation-restore
trap - EXIT HUP INT TERM
restart_api
