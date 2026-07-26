#!/bin/sh
set -eu

backup_name="${REAL_TEST_SQLITE_BACKUP_FILE:-}"
operation="${1:-}"
case "$backup_name" in
  trading-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.sqlite) ;;
  *) echo "real-test SQLite backup file is invalid" >&2; exit 78 ;;
esac
backup="/backups/$backup_name"
backup_uri="file:$backup?immutable=1"
[ -f "$backup" ] && [ ! -L "$backup" ] || {
  echo "real-test SQLite backup is unavailable" >&2
  exit 1
}
[ "$(stat -c '%h:%a:%u:%g' "$backup")" = "1:600:20001:20001" ] || {
  echo "real-test SQLite backup boundary is invalid" >&2
  exit 1
}
[ "$(sqlite3 "$backup_uri" 'PRAGMA integrity_check;')" = ok ] || {
  echo "real-test SQLite backup integrity failed" >&2
  exit 1
}

case "$operation" in
  verify)
    printf 'verified %s\n' "$backup_name"
    ;;
  restore)
    rm -f /app/data/restore.sqlite
    sqlite3 "$backup_uri" "VACUUM INTO '/app/data/restore.sqlite';"
    [ "$(sqlite3 /app/data/restore.sqlite 'PRAGMA integrity_check;')" = ok ] || {
      rm -f /app/data/restore.sqlite
      echo "real-test SQLite restore integrity failed" >&2
      exit 1
    }
    rm -f "$TRADING_DB_PATH-wal" "$TRADING_DB_PATH-shm"
    mv /app/data/restore.sqlite "$TRADING_DB_PATH"
    chmod 0600 "$TRADING_DB_PATH"
    printf 'restored %s\n' "$backup_name"
    ;;
  *)
    echo "usage: sqlite-restore-real-test.sh verify|restore" >&2
    exit 2
    ;;
esac
