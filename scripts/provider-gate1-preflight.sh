#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

[ "$#" -eq 1 ] || { echo "usage: $0 USR-OWNER" >&2; exit 2; }
owner_id="$1"
case "$owner_id" in
  USR-*[!A-Z0-9]*|USR-|*[!A-Z0-9-]*) echo "provider Gate 1 owner is invalid" >&2; exit 2 ;;
  USR-*) ;;
  *) echo "provider Gate 1 owner is invalid" >&2; exit 2 ;;
esac
export RWA_PROVIDER_PREFLIGHT_USER_ID="$owner_id"

. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null
verify_release_containers
production_compose --profile provider-identity-preflight run --rm --no-deps provider-identity-preflight
