#!/bin/sh
set -eu

mode=production
output=build/xingheng-promotion-atomic-exchange
if [ "${1:-}" = --test-root ]; then
  [ "$#" -eq 3 ] || { echo "usage: $0 --test-root ABSOLUTE_ROOT OUTPUT" >&2; exit 2; }
  case "$2" in /tmp/*) ;; *) echo "test root must be under /tmp" >&2; exit 2;; esac
  mode=test
  test_root=${2%/}
  output=$3
elif [ "$#" -ne 0 ]; then
  echo "usage: $0 [--test-root ABSOLUTE_ROOT OUTPUT]" >&2
  exit 2
fi

mkdir -p "${output%/*}"
common_flags="-std=c11 -O2 -Wall -Wextra -Werror -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=2"
if [ "$mode" = production ]; then
  /usr/bin/cc $common_flags -Wl,-z,relro,-z,now -pie \
    native/xingheng-promotion-atomic-exchange.c -o "$output"
else
  /usr/bin/cc $common_flags -Wl,-z,relro,-z,now -pie \
    -DXINGHENG_TEST_BUILD=1 \
    -DXINGHENG_RELEASE_PARENT="\"$test_root/release\"" \
    -DXINGHENG_STATE_PATH="\"$test_root/state/current.json\"" \
    -DXINGHENG_LOCK_ROOT="\"$test_root/locks\"" \
    native/xingheng-promotion-atomic-exchange.c -o "$output"
fi
chmod 0500 "$output"
printf '%s  %s\n' "$(/usr/bin/sha256sum "$output" | /usr/bin/cut -d ' ' -f 1)" "$output"
