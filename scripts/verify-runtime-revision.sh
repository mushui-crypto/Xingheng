#!/bin/sh
set -eu

revision_file="/app/.build-revision"
expected="${XINGHENG_EXPECTED_REVISION:-}"

is_full_revision() {
  [ "${#1}" -eq 40 ] || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

if [ ! -f "$revision_file" ] || [ -L "$revision_file" ] || [ "$(wc -c < "$revision_file")" -ne 41 ]; then
  echo "deployment revision evidence is missing" >&2
  exit 78
fi

IFS= read -r built < "$revision_file" || {
  echo "deployment revision evidence is invalid" >&2
  exit 78
}

if ! is_full_revision "$built" || ! is_full_revision "$expected"; then
  echo "deployment revision is invalid" >&2
  exit 78
fi

if [ "$built" != "$expected" ]; then
  echo "deployment revision mismatch" >&2
  exit 78
fi

exec "$@"
