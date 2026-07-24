#!/bin/sh
set -eu

[ "${1:-}" = "rollback" ] || { echo "usage: $0 rollback" >&2; exit 2; }
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
  rwa-automation-restore flock -n -x /app/rwa-automation-lock/operation.lock \
  node dist-server/operations/rwa-automation-backup.js rollback
trap - EXIT HUP INT TERM
restart_api
