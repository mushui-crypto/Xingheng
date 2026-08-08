#!/bin/sh
set -eu
docker compose exec -T api /app/scripts/sqlite-backup.sh
