#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"
[ "$#" -eq 0 ] || { echo "real-test API stop does not accept arguments" >&2; exit 78; }
[ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = real-test-runtime ] || {
  echo "real-test API stop requires the trusted runtime launcher" >&2
  exit 78
}
exec /usr/bin/node scripts/real-test-runtime-cli.mjs stop
