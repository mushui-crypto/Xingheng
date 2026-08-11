#!/bin/sh
set -eu
umask 077

db_path="${TRADING_DB_PATH:?TRADING_DB_PATH is required}"
user_order_dir="${BINANCE_USER_ORDER_DB_DIR:?BINANCE_USER_ORDER_DB_DIR is required}"
backup_dir=/backups
retention_days="${BACKUP_RETENTION_DAYS:-14}"

[ "$db_path" = /app/data/trading.sqlite ] || {
  echo "TRADING_DB_PATH must use the fixed SQLite volume path" >&2
  exit 78
}
[ "$user_order_dir" = /app/data/binance-users ] || {
  echo "BINANCE_USER_ORDER_DB_DIR must use the fixed SQLite volume path" >&2
  exit 78
}
[ -z "${BACKUP_DIR:-}" ] || {
  echo "BACKUP_DIR override is not allowed" >&2
  exit 78
}
case "$retention_days" in
  ''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS must be a non-negative integer" >&2; exit 2 ;;
esac

backup_sqlite() {
  source_path="$1"
  destination_path="$2"
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || {
    echo "SQLite source is unavailable or unsafe: $source_path" >&2
    exit 1
  }
  sqlite3 "file:$source_path?mode=ro" ".timeout 10000" ".backup '$destination_path'"
  result="$(sqlite3 "$destination_path" "PRAGMA integrity_check;")"
  [ "$result" = ok ] || {
    echo "backup integrity check failed for $source_path: $result" >&2
    exit 1
  }
  chmod 0600 "$destination_path"
}

mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$backup_dir/stellax-$timestamp"
pending="$backup_dir/.stellax-$timestamp.tmp"
[ ! -e "$destination" ] && [ ! -e "$pending" ] || {
  echo "backup snapshot already exists" >&2
  exit 1
}
cleanup() {
  rm -rf "$pending"
}
trap cleanup EXIT HUP INT TERM
mkdir -m 0700 "$pending" "$pending/binance-users"

# SQLite online backup includes committed WAL content without copying live WAL/SHM files.
backup_sqlite "$db_path" "$pending/trading.sqlite"

if [ -d "$user_order_dir" ] && [ ! -L "$user_order_dir" ]; then
  for source_path in "$user_order_dir"/*.sqlite; do
    [ -e "$source_path" ] || continue
    file_name="${source_path##*/}"
    backup_sqlite "$source_path" "$pending/binance-users/$file_name"
  done
  for receipt_path in "$user_order_dir"/*.jsonl; do
    [ -e "$receipt_path" ] || continue
    [ -f "$receipt_path" ] && [ ! -L "$receipt_path" ] || {
      echo "receipt source is unsafe: $receipt_path" >&2
      exit 1
    }
    cp "$receipt_path" "$pending/binance-users/${receipt_path##*/}"
    chmod 0600 "$pending/binance-users/${receipt_path##*/}"
  done
fi

(
  cd "$pending"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)
chmod 0600 "$pending/SHA256SUMS"
mv "$pending" "$destination"
trap - EXIT HUP INT TERM

find "$backup_dir" -mindepth 1 -maxdepth 1 -type d -name 'stellax-*' -mtime "+$retention_days" -exec rm -rf {} +
echo "$destination"
