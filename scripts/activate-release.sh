#!/bin/sh
set -eu

release_manifest="${1:-}"
compose_env="${COMPOSE_ENV_FILE:-.env.production}"
[ -n "$release_manifest" ] || {
  echo "usage: $0 RELEASE_MANIFEST_PATH" >&2
  exit 2
}
RELEASE_MANIFEST_FILE="$release_manifest"
export RELEASE_MANIFEST_FILE

. scripts/load-release-manifest.sh

verify_production_compose
node scripts/verify-deployment-revision.mjs images "$release_manifest"
production_compose up -d api web
verify_release_containers
