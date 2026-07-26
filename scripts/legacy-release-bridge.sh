#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

case "${1:-}" in
  capture|restore|mark-established) ;;
  *) echo "usage: $0 capture|restore|mark-established ARGS..." >&2; exit 2 ;;
esac
exec node scripts/legacy-release-bridge.mjs "$@"
