#!/bin/sh
set -eu

mode=production
if [ "${1:-}" = --test-root ]; then
  [ "$#" -eq 4 ] || { echo "usage: $0 --test-root /tmp/ROOT SOURCE SHA256" >&2; exit 2; }
  test_root=$(/usr/bin/realpath -e -- "$2") || { echo "test root is invalid" >&2; exit 2; }
  [ "$test_root" = "${2%/}" ] || { echo "test root must be canonical" >&2; exit 2; }
  case "$test_root" in
    /tmp/*) ;;
    *) echo "test root must be under /tmp" >&2; exit 2;;
  esac
  case "$test_root" in
    *[!A-Za-z0-9_./-]*) echo "test root contains unsafe characters" >&2; exit 2;;
  esac
  mode=test
  source_binary=$3
  expected_sha256=$4
  destination="$test_root/installed/xingheng-promotion-atomic-exchange"
  receipt="$test_root/receipt/promotion-atomic-exchange.json"
else
  source_binary=${1:-}
  expected_sha256=${2:-}
  destination=/usr/local/libexec/xingheng-promotion-atomic-exchange
  receipt=/etc/xingheng/promotion-atomic-exchange.json
fi
[ "$(/usr/bin/id -u)" -eq 0 ] && [ "$(/usr/bin/id -g)" -eq 0 ] || {
  echo "controlled root is required" >&2
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
  [ "$mode" = test ] || {
    echo "test helper cannot be installed" >&2
    exit 1
  }
elif [ "$mode" = test ]; then
  echo "production helper cannot use the test installer" >&2
  exit 1
fi

install_dir=${destination%/*}
receipt_dir=${receipt%/*}
/usr/bin/install -d -o root -g root -m 0755 "$install_dir"
/usr/bin/install -d -o root -g root -m 0700 "$receipt_dir"
pending="${destination}.pending-$$"
receipt_pending="${receipt}.pending-$$"
trap '/usr/bin/rm -f "$pending" "$receipt_pending"' EXIT HUP INT TERM
/usr/bin/install -o root -g root -m 0500 "$source_binary" "$pending"
[ "$(/usr/bin/sha256sum "$pending" | /usr/bin/cut -d ' ' -f 1)" = "$expected_sha256" ] || exit 1
/usr/bin/mv -f "$pending" "$destination"
/usr/bin/sync -f "$destination"
/usr/bin/sync -f "$install_dir"
if [ "$mode" = test ] && [ "${XINGHENG_PROMOTION_INSTALL_TEST_FAULT:-}" = after-helper ]; then
  echo "injected interruption after helper installation" >&2
  exit 91
fi

helper_dev=$(/usr/bin/stat -c %d "$destination")
helper_ino=$(/usr/bin/stat -c %i "$destination")
helper_size=$(/usr/bin/stat -c %s "$destination")
helper_uid=$(/usr/bin/stat -c %u "$destination")
helper_gid=$(/usr/bin/stat -c %g "$destination")
helper_links=$(/usr/bin/stat -c %h "$destination")
helper_mode=$(/usr/bin/stat -c %a "$destination")
[ "$helper_uid:$helper_gid:$helper_links:$helper_mode" = 0:0:1:500 ] || {
  echo "installed helper boundary is invalid" >&2
  exit 1
}
umask 077
set -C
printf '{"helper":{"dev":%s,"gid":0,"ino":%s,"mode":320,"nlink":1,"path":"%s","sha256":"%s","size":%s,"uid":0},"schemaVersion":1}\n' \
  "$helper_dev" "$helper_ino" "$destination" "$expected_sha256" "$helper_size" > "$receipt_pending"
set +C
/usr/bin/chown root:root "$receipt_pending"
/usr/bin/chmod 0400 "$receipt_pending"
/usr/bin/sync -f "$receipt_pending"
/usr/bin/mv -f "$receipt_pending" "$receipt"
/usr/bin/sync -f "$receipt"
/usr/bin/sync -f "$receipt_dir"
trap - EXIT HUP INT TERM
printf 'PROMOTION_HELPER_INSTALL=PASS sha256=%s receipt=%s\n' "$expected_sha256" "$receipt"
