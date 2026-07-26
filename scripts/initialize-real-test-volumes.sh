#!/bin/sh
set -eu
umask 077

[ "$#" -eq 0 ] || {
  echo "real-test volume initializer accepts no arguments" >&2
  exit 2
}
[ "$(id -u)" -eq 0 ] && [ "$(id -g)" -eq 0 ] || {
  echo "real-test volume initializer requires root" >&2
  exit 1
}

for path in /app/data /app/strategy-data /app/rwa-automation-data; do
  [ -d "$path" ] && [ ! -L "$path" ] || {
    echo "real-test volume root is invalid" >&2
    exit 1
  }
  find "$path" -xdev -mindepth 1 -delete
  chown 20001:20001 "$path"
  chmod 0700 "$path"
done

write_identity() {
  path="$1"
  volume="$2"
  marker="$path/.xingheng-volume-identity.json"
  printf '{"environment":"real-test","schemaVersion":1,"volume":"%s"}\n' "$volume" >"$marker"
  chown 0:0 "$marker"
  chmod 0400 "$marker"
}

write_identity /app/data sqlite_data
write_identity /app/strategy-data strategy_data
write_identity /app/rwa-automation-data rwa_automation_data

install -d -o 20001 -g 20001 -m 0700 /app/rwa-automation-data/generation-initial
install -o 20001 -g 20001 -m 0600 /app/rwa-automation-current.json \
  /app/rwa-automation-data/current.json

for path in /app/data /app/strategy-data /app/rwa-automation-data; do
  [ "$(stat -c '%F:%a:%u:%g' "$path")" = "directory:700:20001:20001" ] || {
    echo "real-test initialized volume boundary is invalid" >&2
    exit 1
  }
done

for marker in \
  /app/data/.xingheng-volume-identity.json \
  /app/strategy-data/.xingheng-volume-identity.json \
  /app/rwa-automation-data/.xingheng-volume-identity.json
do
  [ "$(stat -c '%F:%a:%u:%g:%h' "$marker")" = "regular file:400:0:0:1" ] || {
    echo "real-test initialized volume identity is invalid" >&2
    exit 1
  }
done
