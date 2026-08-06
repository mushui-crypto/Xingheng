#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

[ "$#" -eq 0 ] || { echo "usage: $0" >&2; exit 2; }

operation_id="$(
  /usr/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'
)"
export XINGHENG_CAPITAL_TEST_WINDOW_OPERATION_ID="$operation_id"

RELEASE_MANIFEST_FILE=deploy/release-manifest.json
export RELEASE_MANIFEST_FILE
. scripts/load-release-manifest.sh

verify_production_compose >/dev/null
state_result="$(
  production_compose exec -T api node \
    /app/scripts/verify-production-self-test-permit-state.mjs window
)"
[ "$state_result" = permit-window-state-safe ] || {
  echo "Capital Test window state verification failed" >&2
  exit 1
}

exec /usr/bin/node scripts/capitalTestWindowController.mjs run "$operation_id"
