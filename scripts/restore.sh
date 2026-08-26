#!/bin/sh
set -eu
backup_name="${1:-}"
case "$backup_name" in
  stellax-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) echo "usage: $0 stellax-YYYYMMDDTHHMMSSZ" >&2; exit 2 ;;
esac

if [ "${RESTORE_VALIDATE_ONLY:-false}" = "true" ]; then
  exit 0
fi

docker compose -p xingheng stop api
restart_api() {
  docker compose -p xingheng up -d api web
}
trap restart_api EXIT HUP INT TERM
docker compose -p xingheng --profile sqlite-ops run --rm --no-deps \
  -e SQLITE_RESTORE_SNAPSHOT="$backup_name" sqlite-restore
trap - EXIT HUP INT TERM
docker compose -p xingheng up -d --wait api web
