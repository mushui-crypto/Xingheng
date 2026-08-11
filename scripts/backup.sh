#!/bin/sh
set -eu

docker compose stop api
restart_api() {
  docker compose up -d api web
}
trap restart_api EXIT HUP INT TERM
docker compose --profile sqlite-ops run --rm --no-deps sqlite-backup
trap - EXIT HUP INT TERM
docker compose up -d --wait api web
