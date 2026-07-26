#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

operation_id="${1:-}"
case "$operation_id" in
  ????????-????-4???-[89ab]???-????????????) ;;
  *) echo "usage: $0 RELEASE_OPERATION_ID" >&2; exit 2 ;;
esac

values="$(
  node scripts/releaseLifecycleTransaction.mjs rollback-values "$operation_id"
)"
old_ifs="$IFS"
IFS='
'
set -- $values
IFS="$old_ifs"
[ "$#" -eq 5 ] || {
  echo "release rollback value receipt is invalid" >&2
  exit 78
}
XINGHENG_REVISION="$1"
XINGHENG_API_IMAGE="$2"
XINGHENG_WEB_IMAGE="$3"
XINGHENG_STRATEGY_TOOLS_IMAGE="$4"
expected_environment_sha="$5"
export XINGHENG_REVISION XINGHENG_API_IMAGE XINGHENG_WEB_IMAGE XINGHENG_STRATEGY_TOOLS_IMAGE

rollback_complete=false
keep_stopped_on_failure() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$rollback_complete" != true ]; then
    scripts/production-compose.sh stop api web >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap keep_stopped_on_failure EXIT HUP INT TERM

restored_environment_sha="$(
  node scripts/releaseLifecycleTransaction.mjs restore-environment \
    "$operation_id" "$(pwd -P)/.env.production"
)"
[ "$restored_environment_sha" = "$expected_environment_sha" ] || {
  echo "release rollback environment receipt mismatch" >&2
  exit 78
}

scripts/production-compose.sh up -d api web
node scripts/releaseLifecycleTransaction.mjs verify-rollback-runtime \
  "$operation_id" >/dev/null
node scripts/verify-release-volume-boundaries.mjs runtime
node scripts/releaseLifecycleTransaction.mjs rolled-back "$operation_id" >/dev/null
rollback_complete=true
trap - EXIT HUP INT TERM
printf 'verified release rollback completed\n'
