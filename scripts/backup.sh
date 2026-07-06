#!/bin/sh
set -eu

docker compose --env-file "${COMPOSE_ENV_FILE:-.env.production}" exec -T api /app/scripts/sqlite-backup.sh
