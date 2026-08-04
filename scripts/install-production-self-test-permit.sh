#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

[ "$#" -eq 0 ] || { echo "usage: $0 < permit-authorization.json" >&2; exit 2; }
. scripts/load-release-manifest.sh
verify_production_compose >/dev/null
node scripts/verify-deployment-revision.mjs images "$release_manifest" >/dev/null
node scripts/verify-deployment-revision.mjs containers "$release_manifest" >/dev/null

operation_id="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
export XINGHENG_PERMIT_INSTALL_OPERATION_ID="$operation_id"
export XINGHENG_TRUSTED_OPERATION_ENTRY=install-production-self-test-permit.sh

authorization_identity="$(node scripts/productionSelfTestPermitInstall.mjs authorization-identity "$operation_id")"
set -- $authorization_identity
[ "$#" -eq 3 ] || { echo "Permit authorization identity receipt is invalid" >&2; exit 1; }
owner_user_id="$1"
permit_id="$2"
authorization_sha256="$3"
case "$permit_id:$authorization_sha256" in
  *[!0-9a-f:]*|'') echo "Permit authorization identity is invalid" >&2; exit 1 ;;
esac
[ "${#permit_id}" -eq 32 ] && [ "${#authorization_sha256}" -eq 64 ] || {
  echo "Permit authorization identity is invalid" >&2
  exit 1
}

node scripts/verify-compose-environment-file.mjs production \
  exec -T api node /app/scripts/verify-production-self-test-permit-state.mjs \
  "$owner_user_id" state "$permit_id"

prepared="$(node scripts/productionSelfTestPermitInstall.mjs prepare "$operation_id")"
set -- $prepared
[ "$#" -eq 3 ] || { echo "Permit installation preparation receipt is invalid" >&2; exit 1; }
[ "$1" = "$operation_id" ] || { echo "Permit installation operation identity mismatch" >&2; exit 1; }
owner_user_id="$2"
permit_digest="$3"
case "$permit_digest" in
  *[!0-9a-f]*|'') echo "Permit digest is invalid" >&2; exit 1 ;;
esac
[ "${#permit_digest}" -eq 64 ] || { echo "Permit digest is invalid" >&2; exit 1; }
stage=prepared

finish_failure() {
  status="$?"
  trap - EXIT
  if [ "$stage" = prepared ]; then
    node scripts/productionSelfTestPermitInstall.mjs failed "$operation_id" >/dev/null 2>&1 || true
  elif [ "$stage" = restarting ]; then
    node scripts/productionSelfTestPermitInstall.mjs unknown "$operation_id" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap finish_failure EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

node scripts/productionSelfTestPermitInstall.mjs runtime-before "$operation_id" >/dev/null

stage=restarting
node scripts/verify-compose-environment-file.mjs production up -d api
node scripts/productionSelfTestPermitInstall.mjs runtime-after "$operation_id" >/dev/null

node scripts/productionSelfTestPermitInstall.mjs success "$operation_id"
stage=done
trap - EXIT HUP INT TERM
printf '%s\n' "Production self-test Permit installed; operation=$operation_id"
