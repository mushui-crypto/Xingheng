#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

[ "$#" -eq 3 ] && [ "$1" = terminalize-success ] || {
  echo "usage: $0 terminalize-success SOURCE_RECEIPT_SHA OPERATION_ID" >&2
  exit 2
}
source_receipt_sha256="$2"
operation_id="$3"
case "$source_receipt_sha256" in
  *[!0-9a-f]*|'') echo "Permit terminalization source SHA256 is invalid" >&2; exit 2 ;;
esac
case "$operation_id" in
  *[!0-9a-f]*|'') echo "Permit terminalization operation ID is invalid" >&2; exit 2 ;;
esac
[ "${#source_receipt_sha256}" -eq 64 ] || {
  echo "Permit terminalization source SHA256 is invalid" >&2
  exit 2
}
[ "${#operation_id}" -eq 32 ] || {
  echo "Permit terminalization operation ID is invalid" >&2
  exit 2
}

RELEASE_MANIFEST_FILE=deploy/release-manifest.json
export RELEASE_MANIFEST_FILE
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null

export XINGHENG_TRUSTED_OPERATION_ENTRY=terminalize-production-self-test-permit.sh
export XINGHENG_PERMIT_TERMINALIZATION_OPERATION_ID="$operation_id"
export XINGHENG_PERMIT_TERMINALIZATION_SOURCE_SHA256="$source_receipt_sha256"

exec /usr/bin/node scripts/productionSelfTestPermitTerminalization.mjs \
  terminalize-success "$source_receipt_sha256" "$operation_id"
