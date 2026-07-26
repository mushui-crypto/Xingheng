#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null

restart_api() {
  production_compose up -d api
  production_compose up -d web
  verify_release_containers
}

production_compose stop api
trap restart_api EXIT HUP INT TERM
production_compose --profile rwa-automation-ops run --rm --no-deps rwa-automation-backup
trap - EXIT HUP INT TERM
restart_api
