#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null

restart_api() {
  if production_compose up -d api \
    && production_compose up -d web \
    && verify_release_containers; then
    printf '%s\n' 'XINGHENG_RECEIPT:{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":true,"stage":"api_restoration","category":null}' >&2
  else
    status=$?
    printf 'XINGHENG_RECEIPT:{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":false,"stage":"api_restoration","category":"api_restoration_failed","exitCode":%s}\n' "$status" >&2
    return "$status"
  fi
}

production_compose stop api
trap restart_api EXIT HUP INT TERM
if production_compose --profile rwa-automation-ops run --rm --no-deps rwa-automation-backup; then
  printf '%s\n' 'XINGHENG_RECEIPT:{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":true,"stage":"backup_container","category":null,"exitCode":0}' >&2
else
  status=$?
  printf 'XINGHENG_RECEIPT:{"schemaVersion":1,"operation":"rwa-backup-lifecycle","ok":false,"stage":"backup_container","category":"backup_container_failed","exitCode":%s}\n' "$status" >&2
  exit "$status"
fi
trap - EXIT HUP INT TERM
restart_api
