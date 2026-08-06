#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
  echo "usage: $0 FAILED_RECEIPT_SHA256 [RECOVERY_OPERATION_ID]" >&2
  exit 2
}
case "$1" in
  *[!0-9a-f]*|'') echo "failed receipt SHA256 is invalid" >&2; exit 2 ;;
esac
[ "${#1}" -eq 64 ] || { echo "failed receipt SHA256 is invalid" >&2; exit 2; }

. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null
node scripts/verify-deployment-revision.mjs containers "$release_manifest" >/dev/null

operation_id="${2:-}"
if [ -z "$operation_id" ]; then
  operation_id="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
fi
case "$operation_id" in
  *[!0-9a-f]*|'') echo "recovery operation ID is invalid" >&2; exit 2 ;;
esac
[ "${#operation_id}" -eq 32 ] || { echo "recovery operation ID is invalid" >&2; exit 2; }
printf '%s\n' "PERMIT_RECOVERY_OPERATION_ID=$operation_id"
export XINGHENG_PERMIT_RECOVERY_OPERATION_ID="$operation_id"
export XINGHENG_TRUSTED_OPERATION_ENTRY=recover-production-self-test-permit.sh

node scripts/productionSelfTestPermitRecovery.mjs run "$operation_id" "$1"
