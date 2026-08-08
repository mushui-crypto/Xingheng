#!/bin/sh
set -eu
umask 077

backup_name="${SQLITE_RESTORE_FILE:-}"
case "$backup_name" in
  trading-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.sqlite) ;;
  *) echo "production SQLite restore file is invalid" >&2; exit 78 ;;
esac
backup="/backups/$backup_name"
backup_uri="file:$backup?immutable=1"
[ -f "$backup" ] && [ ! -L "$backup" ] || {
  echo "production SQLite backup is unavailable" >&2
  exit 1
}
[ "$(stat -c '%h:%a:%u:%g' "$backup")" = "1:600:$(id -u):$(id -g)" ] || {
  echo "production SQLite backup boundary is invalid" >&2
  exit 1
}
[ "$(sqlite3 "$backup_uri" 'PRAGMA integrity_check;')" = ok ] || {
  echo "production SQLite backup integrity failed" >&2
  exit 1
}

pending=/app/data/restore.sqlite
rm -f "$pending"
sqlite3 "$backup_uri" "VACUUM INTO '$pending';"
[ "$(sqlite3 "$pending" 'PRAGMA integrity_check;')" = ok ] || {
  rm -f "$pending"
  echo "production SQLite restore integrity failed" >&2
  exit 1
}
chmod 0600 "$pending"
rm -f "$TRADING_DB_PATH-wal" "$TRADING_DB_PATH-shm"
mv "$pending" "$TRADING_DB_PATH"
printf 'restored %s\n' "$backup_name"
