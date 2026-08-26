#!/bin/sh
set -eu

docker compose -p xingheng stop api
restart_api() {
  docker compose -p xingheng up -d api web
}
trap restart_api EXIT HUP INT TERM
docker compose -p xingheng --profile sqlite-ops run --rm --no-deps sqlite-backup
trap - EXIT HUP INT TERM
docker compose -p xingheng up -d --wait api web
