#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

[ "$#" -eq 1 ] || { echo "usage: $0 rwa-automation-YYYYMMDDTHHMMSSZ.rwa.enc.json" >&2; exit 2; }
backup_name="$1"
case "$backup_name" in
  rwa-automation-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.rwa.enc.json) ;;
  *) echo "RWA backup verify basename is invalid" >&2; exit 2 ;;
esac
export RWA_AUTOMATION_VERIFY_FILE="$backup_name"

. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null
verify_release_containers
production_compose --profile rwa-automation-verify run --rm --no-deps rwa-automation-verify
