#!/bin/sh
set -eu
umask 077

snapshot_name="${SQLITE_RESTORE_SNAPSHOT:-}"
case "$snapshot_name" in
  stellax-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) echo "production SQLite restore snapshot is invalid" >&2; exit 78 ;;
esac
[ "${TRADING_DB_PATH:?TRADING_DB_PATH is required}" = /app/data/trading.sqlite ] || {
  echo "TRADING_DB_PATH must use the fixed SQLite volume path" >&2
  exit 78
}
[ "${BINANCE_USER_ORDER_DB_DIR:?BINANCE_USER_ORDER_DB_DIR is required}" = /app/data/binance-users ] || {
  echo "BINANCE_USER_ORDER_DB_DIR must use the fixed SQLite volume path" >&2
  exit 78
}

snapshot="/backups/$snapshot_name"
[ -d "$snapshot" ] && [ ! -L "$snapshot" ] || {
  echo "production backup snapshot is unavailable" >&2
  exit 1
}
[ "$(stat -c '%a:%u:%g' "$snapshot")" = "700:$(id -u):$(id -g)" ] || {
  echo "production backup snapshot permission boundary is invalid" >&2
  exit 1
}
[ -d "$snapshot/binance-users" ] && [ ! -L "$snapshot/binance-users" ] || {
  echo "production Binance user order backup directory is unavailable" >&2
  exit 1
}
[ "$(stat -c '%a:%u:%g' "$snapshot/binance-users")" = "700:$(id -u):$(id -g)" ] || {
  echo "production Binance user order backup permission boundary is invalid" >&2
  exit 1
}
[ -f "$snapshot/SHA256SUMS" ] && [ ! -L "$snapshot/SHA256SUMS" ] || {
  echo "production backup checksum manifest is unavailable" >&2
  exit 1
}
[ "$(stat -c '%h:%a:%u:%g' "$snapshot/SHA256SUMS")" = "1:600:$(id -u):$(id -g)" ] || {
  echo "production backup checksum permission boundary is invalid" >&2
  exit 1
}
(
  cd "$snapshot"
  sha256sum -c SHA256SUMS
)

validate_sqlite() {
  source_path="$1"
  [ -f "$source_path" ] && [ ! -L "$source_path" ] || {
    echo "production SQLite backup is unavailable or unsafe: $source_path" >&2
    exit 1
  }
  [ "$(stat -c '%h:%a:%u:%g' "$source_path")" = "1:600:$(id -u):$(id -g)" ] || {
    echo "production SQLite backup permission boundary is invalid: $source_path" >&2
    exit 1
  }
  [ "$(sqlite3 "file:$source_path?immutable=1" 'PRAGMA integrity_check;')" = ok ] || {
    echo "production SQLite backup integrity failed: $source_path" >&2
    exit 1
  }
}

validate_user_db_name() {
  file_name="${1##*/}"
  stem="${file_name%.sqlite}"
  [ "$file_name" != "$stem" ] && [ "${#stem}" -eq 32 ] || return 1
  case "$stem" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

validate_sqlite "$snapshot/trading.sqlite"
for source_path in "$snapshot/binance-users"/*.sqlite; do
  [ -e "$source_path" ] || continue
  validate_user_db_name "$source_path" || {
    echo "production Binance user order backup name is invalid" >&2
    exit 1
  }
  validate_sqlite "$source_path"
done
for receipt_path in "$snapshot/binance-users"/*.jsonl; do
  [ -e "$receipt_path" ] || continue
  [ -f "$receipt_path" ] && [ ! -L "$receipt_path" ] || {
    echo "production receipt backup is unsafe" >&2
    exit 1
  }
  [ "$(stat -c '%h:%a:%u:%g' "$receipt_path")" = "1:600:$(id -u):$(id -g)" ] || {
    echo "production receipt backup permission boundary is invalid" >&2
    exit 1
  }
done

pending="/app/data/.stellax-restore-pending-$$"
previous="/app/data/.stellax-restore-previous-$$"
swap_started=false
complete=false
cleanup() {
  status=$?
  if [ "$swap_started" = true ] && [ "$complete" != true ]; then
    rm -f "$TRADING_DB_PATH" "$TRADING_DB_PATH-wal" "$TRADING_DB_PATH-shm"
    rm -rf "$BINANCE_USER_ORDER_DB_DIR"
    [ ! -f "$previous/trading.sqlite" ] || mv "$previous/trading.sqlite" "$TRADING_DB_PATH"
    [ ! -d "$previous/binance-users" ] || mv "$previous/binance-users" "$BINANCE_USER_ORDER_DB_DIR"
  fi
  rm -rf "$pending" "$previous"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
mkdir -m 0700 "$pending" "$pending/binance-users" "$previous"

sqlite3 "file:$snapshot/trading.sqlite?immutable=1" "VACUUM INTO '$pending/trading.sqlite';"
chmod 0600 "$pending/trading.sqlite"
for source_path in "$snapshot/binance-users"/*.sqlite; do
  [ -e "$source_path" ] || continue
  destination_path="$pending/binance-users/${source_path##*/}"
  sqlite3 "file:$source_path?immutable=1" "VACUUM INTO '$destination_path';"
  chmod 0600 "$destination_path"
done
for receipt_path in "$snapshot/binance-users"/*.jsonl; do
  [ -e "$receipt_path" ] || continue
  cp "$receipt_path" "$pending/binance-users/${receipt_path##*/}"
  chmod 0600 "$pending/binance-users/${receipt_path##*/}"
done

swap_started=true
rm -f "$TRADING_DB_PATH-wal" "$TRADING_DB_PATH-shm"
[ ! -f "$TRADING_DB_PATH" ] || mv "$TRADING_DB_PATH" "$previous/trading.sqlite"
[ ! -d "$BINANCE_USER_ORDER_DB_DIR" ] || mv "$BINANCE_USER_ORDER_DB_DIR" "$previous/binance-users"
mv "$pending/trading.sqlite" "$TRADING_DB_PATH"
mv "$pending/binance-users" "$BINANCE_USER_ORDER_DB_DIR"
complete=true
rm -rf "$pending" "$previous"
trap - EXIT HUP INT TERM
printf 'restored %s\n' "$snapshot_name"
