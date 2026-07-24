#!/bin/sh

release_manifest="${RELEASE_MANIFEST_FILE:-deploy/release-manifest.json}"
compose_env="${COMPOSE_ENV_FILE:-.env.production}"

XINGHENG_REVISION="$(node scripts/verify-deployment-revision.mjs env "$release_manifest" "$compose_env")" || return 1
XINGHENG_API_IMAGE="$(node scripts/verify-deployment-revision.mjs manifest-image "$release_manifest" api)" || return 1
XINGHENG_WEB_IMAGE="$(node scripts/verify-deployment-revision.mjs manifest-image "$release_manifest" web)" || return 1
XINGHENG_STRATEGY_TOOLS_IMAGE="$(node scripts/verify-deployment-revision.mjs manifest-image "$release_manifest" strategyTools)" || return 1

export XINGHENG_REVISION
export XINGHENG_API_IMAGE
export XINGHENG_WEB_IMAGE
export XINGHENG_STRATEGY_TOOLS_IMAGE

verify_production_compose() {
  node scripts/verify-deployment-revision.mjs compose "$release_manifest" "$compose_env"
}

production_compose() {
  verify_production_compose >/dev/null
  scripts/production-compose.sh --env-file "$compose_env" "$@"
}

stop_unverified_release() {
  scripts/production-compose.sh --env-file "$compose_env" stop api web >/dev/null 2>&1 || true
}

verify_release_containers() {
  if node scripts/verify-deployment-revision.mjs containers "$release_manifest" >/dev/null; then
    return 0
  fi
  stop_unverified_release
  return 1
}
