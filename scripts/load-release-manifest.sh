#!/bin/sh

if env | grep -q '^COMPOSE_'; then
  echo "production Compose control environment is not allowed" >&2
  return 78
fi

release_manifest="${RELEASE_MANIFEST_FILE:-deploy/release-manifest.json}"
compose_env="$(pwd -P)/.env.production"

manifest_values="$(
  node scripts/verify-deployment-revision.mjs manifest-values "$release_manifest" "$compose_env"
)" || return 1
old_ifs="$IFS"
IFS='
'
set -- $manifest_values
IFS="$old_ifs"
if [ "$#" -ne 4 ]; then
  echo "release manifest value receipt is invalid" >&2
  return 1
fi
XINGHENG_REVISION="$1"
XINGHENG_API_IMAGE="$2"
XINGHENG_WEB_IMAGE="$3"
XINGHENG_STRATEGY_TOOLS_IMAGE="$4"

export XINGHENG_REVISION
export XINGHENG_API_IMAGE
export XINGHENG_WEB_IMAGE
export XINGHENG_STRATEGY_TOOLS_IMAGE

verify_production_compose() {
  node scripts/verify-deployment-revision.mjs compose "$release_manifest" "$compose_env"
}

production_compose() {
  verify_production_compose >/dev/null
  scripts/production-compose.sh "$@"
}

stop_unverified_release() {
  scripts/production-compose.sh stop api web >/dev/null 2>&1 || true
}

verify_release_containers() {
  if node scripts/verify-deployment-revision.mjs containers "$release_manifest" >/dev/null; then
    return 0
  fi
  stop_unverified_release
  return 1
}
