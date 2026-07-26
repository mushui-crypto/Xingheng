#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

release_manifest="${1:-}"
[ -n "$release_manifest" ] || {
  echo "usage: $0 RELEASE_MANIFEST_PATH" >&2
  exit 2
}
if [ "$(/usr/bin/id -u)" -eq 0 ] && [ "$release_manifest" != deploy/release-manifest.json ]; then
  echo "standard activation requires the canonical release manifest" >&2
  exit 78
fi
RELEASE_MANIFEST_FILE="$release_manifest"
export RELEASE_MANIFEST_FILE

. scripts/load-release-manifest.sh

verify_production_compose
node scripts/verify-deployment-revision.mjs images "$release_manifest"

lifecycle_operation=""
lifecycle_prepared=false
activation_stage=preflight
if [ "$(/usr/bin/id -u)" -eq 0 ] \
  && [ "${XINGHENG_FIRST_VERIFIED_ACTIVATION:-false}" != true ]; then
  [ -f /var/lib/xingheng/verified-release-established ] || {
    echo "standard activation requires the one-way verified release marker" >&2
    exit 78
  }
  lifecycle_operation="$(
    node scripts/releaseLifecycleTransaction.mjs prepare \
      "$release_manifest" "$compose_env"
  )"
  lifecycle_prepared=true
fi

activation_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$lifecycle_prepared" = true ]; then
    stop_unverified_release || true
    if ! node scripts/releaseLifecycleTransaction.mjs incident \
      "$lifecycle_operation" activation_failed "$activation_stage" "$status" >/dev/null; then
      status=1
    fi
  fi
  exit "$status"
}
trap activation_exit EXIT HUP INT TERM

activation_stage=compose_up
production_compose up -d api web
activation_stage=verify_release_containers
verify_release_containers
if [ "$lifecycle_prepared" = true ]; then
  activation_stage=lifecycle_complete
  node scripts/releaseLifecycleTransaction.mjs complete \
    "$lifecycle_operation" "$release_manifest" "$compose_env" >/dev/null
  lifecycle_prepared=false
fi
trap - EXIT HUP INT TERM
