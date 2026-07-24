#!/bin/sh
set -eu

compose_env="${COMPOSE_ENV_FILE:-.env.production}"
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
verify_release_containers
production_compose exec -T api /app/scripts/sqlite-backup.sh
