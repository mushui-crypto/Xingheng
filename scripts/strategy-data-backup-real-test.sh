#!/bin/sh
set -eu
umask 077

operation="${1:-}"
backup_dir=/backups
strategy_dir=/app/strategy-data

validate_name() {
  case "$1" in
    strategy-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.tar.gz) ;;
    *) echo "real-test strategy backup file is invalid" >&2; exit 78 ;;
  esac
}

validate_archive() {
  archive="$1"
  [ -f "$archive" ] && [ ! -L "$archive" ] || {
    echo "real-test strategy backup is unavailable" >&2
    exit 1
  }
  [ "$(stat -c '%h:%a:%u:%g' "$archive")" = "1:600:20001:20001" ] || {
    echo "real-test strategy backup boundary is invalid" >&2
    exit 1
  }
  tar -tzf "$archive" | while IFS= read -r entry; do
    [ "$entry" != "./.xingheng-volume-identity.json" ] || {
      echo "real-test strategy backup contains the reserved volume identity" >&2
      exit 1
    }
    case "$entry" in
      .|./|./[A-Za-z0-9._-]*|./[A-Za-z0-9._-]*/*) ;;
      *) echo "real-test strategy backup member is invalid" >&2; exit 1 ;;
    esac
    case "/$entry/" in
      */../*|*/././*) echo "real-test strategy backup traversal is invalid" >&2; exit 1 ;;
    esac
  done
  tar -tvzf "$archive" | while IFS= read -r entry; do
    case "$entry" in
      d*|-*) ;;
      *) echo "real-test strategy backup contains a non-regular member" >&2; exit 1 ;;
    esac
  done
}

case "$operation" in
  create)
    [ "$#" -eq 1 ] || exit 2
    find "$strategy_dir" -xdev -mindepth 1 \( -type f -o -type d \) -print >/dev/null
    [ -z "$(find "$strategy_dir" -xdev -mindepth 1 ! -type f ! -type d -print -quit)" ] || {
      echo "real-test strategy data contains an unsupported member" >&2
      exit 1
    }
    timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
    name="strategy-$timestamp.tar.gz"
    pending="$backup_dir/.$name.pending"
    archive="$backup_dir/$name"
    [ ! -e "$pending" ] && [ ! -L "$pending" ] && [ ! -e "$archive" ] && [ ! -L "$archive" ] || {
      echo "real-test strategy backup destination already exists" >&2
      exit 1
    }
    tar --sort=name --numeric-owner --owner=20001 --group=20001 \
      --mode=u+rwX,go-rwx --exclude=./.xingheng-volume-identity.json \
      -C "$strategy_dir" -czf "$pending" .
    chmod 0600 "$pending"
    mv "$pending" "$archive"
    validate_archive "$archive"
    printf '%s\n' "$name"
    ;;
  verify|restore)
    [ "$#" -eq 1 ] || exit 2
    name="${REAL_TEST_STRATEGY_BACKUP_FILE:-}"
    validate_name "$name"
    archive="$backup_dir/$name"
    validate_archive "$archive"
    if [ "$operation" = restore ]; then
      find "$strategy_dir" -xdev -mindepth 1 \
        ! -name .xingheng-volume-identity.json -delete
      tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$strategy_dir"
      find "$strategy_dir" -xdev -type d -exec chmod 0700 {} +
      find "$strategy_dir" -xdev -type f \
        ! -name .xingheng-volume-identity.json -exec chmod 0600 {} +
      [ "$(stat -c '%F:%a:%u:%g:%h' \
        "$strategy_dir/.xingheng-volume-identity.json")" = "regular file:400:0:0:1" ] || {
        echo "real-test strategy volume identity is invalid" >&2
        exit 1
      }
      [ -z "$(find "$strategy_dir" -xdev -mindepth 1 ! -type f ! -type d -print -quit)" ] || {
        echo "real-test strategy restore member validation failed" >&2
        exit 1
      }
    fi
    printf '%s %s\n' "$operation" "$name"
    ;;
  *)
    echo "usage: strategy-data-backup-real-test.sh create|verify|restore" >&2
    exit 2
    ;;
esac
