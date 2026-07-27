#!/bin/sh
set -eu

mode="${1:-}"
case "$mode" in
  shared|standalone) ;;
  *) echo "usage: $0 shared|standalone" >&2; exit 2 ;;
esac

case "$0" in
  */*) ;;
  *) echo "real-test activation entry must be invoked by an explicit path" >&2; exit 78 ;;
esac
script_dir="$(CDPATH= cd -P -- "${0%/*}" && pwd -P)"
repo_root="${script_dir%/*}"
cd "$repo_root"

if [ "$(/usr/bin/id -u)" -eq 0 ] && [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" != real-test ]; then
  [ -z "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" ] || {
    echo "real-test activation inherited operation lock context is invalid" >&2
    exit 78
  }
  exec /usr/bin/env -i \
    HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    /usr/bin/node "$script_dir/trusted-operation-launcher.mjs" \
    real-test scripts/activate-real-test-release.sh "$mode"
fi
[ "$(/usr/bin/id -u)" -ne 0 ] || [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = real-test ] || {
  echo "real-test activation requires the trusted launcher" >&2
  exit 78
}

release_manifest="deploy/release-manifest.json"
compose_env="$(pwd -P)/.env.real-test"
manifest_values="$(
  node scripts/verify-deployment-revision.mjs \
    manifest-values "$release_manifest" "$compose_env"
)"
old_ifs="$IFS"
IFS='
'
set -- $manifest_values
IFS="$old_ifs"
[ "$#" -eq 4 ] || {
  echo "real-test release manifest receipt is invalid" >&2
  exit 78
}
XINGHENG_REVISION="$1"
XINGHENG_API_IMAGE="$2"
XINGHENG_WEB_IMAGE="$3"
XINGHENG_STRATEGY_TOOLS_IMAGE="$4"
export XINGHENG_REVISION XINGHENG_API_IMAGE XINGHENG_WEB_IMAGE XINGHENG_STRATEGY_TOOLS_IMAGE

if [ "$mode" = standalone ]; then
  compose_entry="scripts/real-test-standalone-compose.sh"
  compose_verifier="compose-real-test-standalone"
else
  compose_entry="scripts/real-test-compose.sh"
  compose_verifier="compose-real-test"
fi

node scripts/verify-deployment-revision.mjs \
  "$compose_verifier" "$release_manifest" "$compose_env"
node scripts/verify-deployment-revision.mjs images "$release_manifest"

activated=false
stop_on_failure() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$activated" != true ]; then
    "$compose_entry" stop api web >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap stop_on_failure EXIT HUP INT TERM

"$compose_entry" up -d api web
node scripts/verify-deployment-revision.mjs \
  containers-real-test "$release_manifest"
node scripts/verify-release-volume-boundaries.mjs real-test runtime
activated=true
trap - EXIT HUP INT TERM
printf 'verified %s real-test release activated\n' "$mode"
