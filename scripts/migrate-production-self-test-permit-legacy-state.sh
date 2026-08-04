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

node scripts/verify-compose-environment-file.mjs production \
  exec -T api node /app/scripts/productionSelfTestPermitLegacyState.mjs migrate \
  "$owner_user_id" \
  e0c3703b9a008ae5bcdfa56f413a6f36 \
  "$failed_receipt_sha256"
