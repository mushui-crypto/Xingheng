#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

backup_name="${1:-}"
case "$backup_name" in
  trading-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.sqlite) ;;
  *) echo "usage: $0 trading-YYYYMMDDTHHMMSSZ.sqlite" >&2; exit 2 ;;
esac

if [ "${RESTORE_VALIDATE_ONLY:-false}" = "true" ]; then
  exit 0
fi

. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null

production_compose stop api
restart_api() {
  production_compose up -d api
  production_compose up -d web
  verify_release_containers
}
trap restart_api EXIT HUP INT TERM
production_compose --profile sqlite-ops run --rm --no-deps \
  -e SQLITE_RESTORE_FILE="$backup_name" sqlite-restore
trap - EXIT HUP INT TERM
production_compose up -d api
production_compose up -d web
verify_release_containers
