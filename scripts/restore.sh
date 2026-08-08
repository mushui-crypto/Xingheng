#!/bin/sh
set -eu
backup_name="${1:-}"
case "$backup_name" in
  trading-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.sqlite) ;;
  *) echo "usage: $0 trading-YYYYMMDDTHHMMSSZ.sqlite" >&2; exit 2 ;;
esac

if [ "${RESTORE_VALIDATE_ONLY:-false}" = "true" ]; then
  exit 0
fi

docker compose stop api
restart_api() {
  docker compose up -d api web
}
trap restart_api EXIT HUP INT TERM
docker compose --profile sqlite-ops run --rm --no-deps \
  -e SQLITE_RESTORE_FILE="$backup_name" sqlite-restore
trap - EXIT HUP INT TERM
docker compose up -d api web
