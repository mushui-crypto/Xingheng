#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"
[ "$#" -eq 0 ] || { echo "real-test runtime install does not accept arguments" >&2; exit 78; }
[ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = real-test-runtime-install ] || {
  echo "real-test runtime install requires the trusted launcher" >&2
  exit 78
}
exec /usr/bin/node scripts/real-test-runtime-install-cli.mjs
