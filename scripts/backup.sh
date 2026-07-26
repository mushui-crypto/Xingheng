#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
verify_release_containers
production_compose exec -T api /app/scripts/sqlite-backup.sh
