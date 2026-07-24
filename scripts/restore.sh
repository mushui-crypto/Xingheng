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

compose_env="${COMPOSE_ENV_FILE:-.env.production}"
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null

production_compose stop api
production_compose run --rm --no-deps --entrypoint sh api -c '
  set -eu
  backup="/backups/$1"
  test -f "$backup"
  check="$(sqlite3 "$backup" "PRAGMA integrity_check;")"
  test "$check" = ok
  rm -f /app/data/restore.sqlite
  sqlite3 /app/data/restore.sqlite ".restore $backup"
  check="$(sqlite3 /app/data/restore.sqlite "PRAGMA integrity_check;")"
  test "$check" = ok
  rm -f "$TRADING_DB_PATH-wal" "$TRADING_DB_PATH-shm"
  mv /app/data/restore.sqlite "$TRADING_DB_PATH"
' sh "$backup_name"
production_compose up -d api
production_compose up -d web
verify_release_containers
