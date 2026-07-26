#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

bridge_dir="${1:-}"
release_manifest="${2:-}"
release_environment="${3:-}"
state_file="/var/lib/xingheng/verified-release-established"
if [ -n "${LEGACY_BRIDGE_STATE_FILE:-}" ]; then
  [ "${NODE_ENV:-}" = test ] || {
    echo "legacy bridge marker override is test-only" >&2
    exit 78
  }
  state_file="$LEGACY_BRIDGE_STATE_FILE"
fi

[ -n "$bridge_dir" ] && [ -n "$release_manifest" ] && [ -n "$release_environment" ] || {
  echo "usage: $0 LEGACY_BRIDGE_DIR RELEASE_MANIFEST RELEASE_ENV_FILE" >&2
  exit 2
}
case "$release_environment" in
  /*) ;;
  *) echo "verified release environment path must be absolute" >&2; exit 78 ;;
esac
[ ! -e "$state_file" ] && [ ! -L "$state_file" ] || {
  echo "legacy bridge is permanently disabled after the verified release chain is established" >&2
  exit 78
}

node scripts/legacy-release-bridge.mjs verify "$bridge_dir"
node scripts/legacy-release-bridge.mjs verify-runtime "$bridge_dir"
node scripts/legacy-release-bridge.mjs verify-release-environment \
  "$bridge_dir" "$release_environment"

fixed_environment="$(pwd -P)/.env.production"
environment_receipt="$(
  node scripts/install-production-environment.mjs install \
    "$release_environment" "$fixed_environment"
)"
environment_installed=true
cleanup_environment_on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$environment_installed" = true ]; then
    node scripts/install-production-environment.mjs uninstall \
      - "$fixed_environment" "$environment_receipt" || status=1
  fi
  exit "$status"
}
trap cleanup_environment_on_exit EXIT HUP INT TERM

RELEASE_MANIFEST_FILE="$release_manifest"
export RELEASE_MANIFEST_FILE
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null
node scripts/first-release-volume-migration.mjs initialize "$XINGHENG_API_IMAGE"
production_compose run --rm --no-deps --entrypoint node api \
  dist-server/operations/rwa-activation-preflight.js

# No legacy runtime or existing data volume is changed before release, WIF/KMS, and new-volume preflight succeeds.
legacy_stopped=false
owners_changed=false
activated=false
lifecycle_established=false
rollback_after_activation() {
  stop_status=0
  owner_status=0
  restore_status=0
  environment_status=0
  lifecycle_status=0
  if [ "$legacy_stopped" = true ]; then
    legacy_stopped=false
    activated=false
    stop_unverified_release || stop_status=$?
    if [ "$owners_changed" = true ]; then
      node scripts/first-release-volume-migration.mjs restore \
        "$bridge_dir" "$XINGHENG_API_IMAGE" || owner_status=$?
    fi
    owners_changed=false
    node scripts/legacy-release-bridge.mjs restore "$bridge_dir" || restore_status=$?
  fi
  if [ "$lifecycle_established" = true ]; then
    node scripts/releaseLifecycleTransaction.mjs unestablish \
      "$XINGHENG_REVISION" >/dev/null || lifecycle_status=$?
    lifecycle_established=false
  fi
  if [ "$environment_installed" = true ]; then
    node scripts/install-production-environment.mjs uninstall \
      - "$fixed_environment" "$environment_receipt" || environment_status=$?
    environment_installed=false
  fi
  [ "$stop_status" -eq 0 ] && [ "$owner_status" -eq 0 ] \
    && [ "$restore_status" -eq 0 ] && [ "$environment_status" -eq 0 ] \
    && [ "$lifecycle_status" -eq 0 ]
}

rollback_on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if ! rollback_after_activation; then
    status=1
  fi
  exit "$status"
}
trap rollback_on_exit EXIT HUP INT TERM

legacy_stopped=true
production_compose stop api
owners_changed=true
node scripts/first-release-volume-migration.mjs migrate \
  "$bridge_dir" "$XINGHENG_API_IMAGE"
node scripts/verify-release-volume-boundaries.mjs migration

activated=true
XINGHENG_FIRST_VERIFIED_ACTIVATION=true
export XINGHENG_FIRST_VERIFIED_ACTIVATION
if ! ./scripts/activate-release.sh "$release_manifest"; then
  rollback_after_activation
  exit 1
fi
unset XINGHENG_FIRST_VERIFIED_ACTIVATION

verify_release_containers
node scripts/verify-deployment-revision.mjs containers "$release_manifest" >/dev/null
node scripts/verify-release-volume-boundaries.mjs runtime
node scripts/releaseLifecycleTransaction.mjs establish \
  "$release_manifest" "$fixed_environment" >/dev/null
lifecycle_established=true
mkdir -p "$(dirname "$state_file")"
node scripts/legacy-release-bridge.mjs mark-established "$state_file" "$XINGHENG_REVISION"
lifecycle_established=false
activated=false
environment_installed=false
trap - EXIT HUP INT TERM
printf 'first verified release activated\n'
