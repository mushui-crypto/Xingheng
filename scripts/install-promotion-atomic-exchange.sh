#!/bin/sh
set -eu

source_binary=${1:-}
expected_sha256=${2:-}
[ "$#" -eq 2 ] && [ "$(/usr/bin/id -u)" -eq 0 ] && [ "$(/usr/bin/id -g)" -eq 0 ] || {
  echo "usage: $0 SOURCE_BINARY EXPECTED_SHA256 (controlled root required)" >&2
  exit 2
}
case "$source_binary" in /*) ;; *) echo "helper source path must be absolute" >&2; exit 2;; esac
case "$expected_sha256" in *[!a-f0-9]*|'') echo "helper SHA-256 is invalid" >&2; exit 2;; esac
[ "${#expected_sha256}" -eq 64 ] || { echo "helper SHA-256 is invalid" >&2; exit 2; }
[ -f "$source_binary" ] && [ ! -L "$source_binary" ] || { echo "helper source boundary is invalid" >&2; exit 1; }
[ "$(/usr/bin/stat -c %h "$source_binary")" = 1 ] || { echo "helper source link count is invalid" >&2; exit 1; }
[ "$(/usr/bin/sha256sum "$source_binary" | /usr/bin/cut -d ' ' -f 1)" = "$expected_sha256" ] || {
  echo "helper source SHA-256 mismatch" >&2; exit 1;
}
if LC_ALL=C /usr/bin/grep -a -q XINGHENG_PROMOTION_TEST_BUILD "$source_binary"; then
  echo "test helper cannot be installed" >&2
  exit 1
fi

destination=/usr/local/libexec/xingheng-promotion-atomic-exchange
/usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec
pending="${destination}.pending-$$"
trap '/usr/bin/rm -f "$pending"' EXIT HUP INT TERM
/usr/bin/install -o root -g root -m 0500 "$source_binary" "$pending"
[ "$(/usr/bin/sha256sum "$pending" | /usr/bin/cut -d ' ' -f 1)" = "$expected_sha256" ] || exit 1
/usr/bin/mv -f "$pending" "$destination"
/usr/bin/sync -f "$destination"
/usr/bin/sync -f /usr/local/libexec
trap - EXIT HUP INT TERM
script_dir="$(CDPATH= cd -P -- "${0%/*}" && pwd -P)"
trust_output="$(/usr/bin/env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  /usr/bin/node "$script_dir/install-trusted-operations.mjs" install)"
case "$trust_output" in *'"ok":true'*'"receiptSha256":'*) ;; *)
  echo "promotion helper trust binding failed" >&2
  exit 1
  ;;
esac
printf 'PROMOTION_HELPER_INSTALL=PASS sha256=%s\n%s\n' "$expected_sha256" "$trust_output"
