#!/bin/sh
set -eu

db_path="${TRADING_DB_PATH:?TRADING_DB_PATH is required}"
backup_dir=/backups
retention_days="${BACKUP_RETENTION_DAYS:-14}"

[ "$db_path" = /app/data/trading.sqlite ] || {
  echo "TRADING_DB_PATH must use the fixed SQLite volume path" >&2
  exit 78
}
[ -z "${BACKUP_DIR:-}" ] || {
  echo "BACKUP_DIR override is not allowed" >&2
  exit 78
}
case "$retention_days" in
  ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2; exit 2 ;;
esac

mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$backup_dir/trading-$timestamp.sqlite"

# SQLite's online backup API creates a transactionally consistent snapshot,
# including committed WAL content, without copying live database files.
sqlite3 "file:$db_path?mode=ro" ".timeout 10000" ".backup '$destination'"
chmod 0600 "$destination"
result="$(sqlite3 "$destination" "PRAGMA integrity_check;")"
[ "$result" = "ok" ] || { echo "backup integrity check failed: $result" >&2; rm -f "$destination"; exit 1; }

find "$backup_dir" -type f -name 'trading-*.sqlite' -mtime "+$retention_days" -delete
echo "$destination"
