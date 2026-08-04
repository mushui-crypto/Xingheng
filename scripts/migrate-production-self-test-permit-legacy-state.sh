#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

[ "$#" -eq 0 ] || { echo "usage: $0" >&2; exit 2; }
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null
node scripts/verify-deployment-revision.mjs containers "$release_manifest" >/dev/null

export XINGHENG_TRUSTED_OPERATION_ENTRY=migrate-production-self-test-permit-legacy-state.sh
legacy_failure="$(node scripts/productionSelfTestPermitLegacyState.mjs verify-failure)"
set -- $legacy_failure
[ "$#" -eq 2 ] || { echo "legacy failed Permit receipt is invalid" >&2; exit 1; }
owner_user_id="$1"
failed_receipt_sha256="$2"

restart_api() {
  production_compose up -d api
  production_compose up -d web
  verify_release_containers
}

production_compose stop api
trap restart_api EXIT HUP INT TERM
[ -z "$(production_compose ps --status running -q api)" ] || {
  echo "legacy Permit migration requires the API writer to be stopped" >&2
  exit 1
}
production_compose --profile rwa-automation-ops run --rm --no-deps \
  -e XINGHENG_TRUSTED_OPERATION_ENTRY=migrate-production-self-test-permit-legacy-state.sh \
  -e XINGHENG_OPERATION_LOCK_CONTEXT=production \
  rwa-automation-restore flock -n -x /app/rwa-automation-lock/operation.lock \
  node /app/scripts/productionSelfTestPermitLegacyState.mjs migrate \
  "$owner_user_id" e0c3703b9a008ae5bcdfa56f413a6f36 "$failed_receipt_sha256"
trap - EXIT HUP INT TERM
restart_api
