#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

environment="${1:-}"
source_dir="${2:-}"
audience_file="${3:-}"
case "$environment" in
  production) target="/run/xingheng/gcp-wif" ;;
  *) echo "WIF installation environment must be production" >&2; exit 2 ;;
esac
if [ -n "${WIF_HOST_ROOT:-}" ]; then
  [ "${NODE_ENV:-}" = test ] || {
    echo "WIF target override is test-only" >&2
    exit 78
  }
  target="$WIF_HOST_ROOT"
fi

[ -n "$source_dir" ] && [ -n "$audience_file" ] && [ "$#" -eq 3 ] || {
  echo "usage: $0 production ROOT_ONLY_SOURCE_DIR ROOT_ONLY_AUDIENCE_FILE" >&2
  exit 2
}
[ "$(id -u)" = 0 ] || {
  echo "WIF installation requires the controlled root operator" >&2
  exit 77
}
case "$source_dir:$audience_file:$target" in
  /*:/*:/*) ;;
  *) echo "WIF installation paths must be absolute" >&2; exit 2 ;;
esac
[ ! -e "$target" ] && [ ! -L "$target" ] || {
  echo "WIF target already exists; rotation requires a separate controlled procedure" >&2
  exit 78
}

node scripts/verify-gcp-wif-bundle.mjs source "$source_dir" "$audience_file"

parent="$(dirname "$target")"
if [ "${NODE_ENV:-}" != test ]; then
  expected_parent="/run/xingheng"
  [ "$parent" = "$expected_parent" ] || {
    echo "WIF target parent is invalid" >&2
    exit 78
  }
  [ "$(findmnt -n -o TARGET -T /run)" = /run ] \
    && [ "$(findmnt -n -o FSTYPE -T /run)" = tmpfs ] || {
    echo "WIF runtime root is not the frozen tmpfs" >&2
    exit 78
  }
fi
mounted=false
published=false
parent_mount_created=false
cleanup() {
  if [ "$mounted" = true ]; then
    umount "$stage" >/dev/null 2>&1 || true
  fi
  if [ "$published" = true ]; then
    umount "$target" >/dev/null 2>&1 || true
  fi
  rmdir "$stage" >/dev/null 2>&1 || true
  if [ -d "$target" ] && ! mountpoint -q "$target"; then
    rmdir "$target" >/dev/null 2>&1 || true
  fi
  if [ "$parent_mount_created" = true ]; then
    umount "$parent" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

install -d -o 0 -g 0 -m 0755 "$parent"
[ ! -L "$parent" ] || {
  echo "WIF target parent is unsafe" >&2
  exit 78
}
if [ "${NODE_ENV:-}" != test ]; then
  [ "$(stat -c '%u %g %a' "$parent")" = "0 0 755" ] || {
    echo "WIF target parent boundary is invalid" >&2
    exit 78
  }
  [ "$(findmnt -n -o FSTYPE -T "$parent")" = tmpfs ] || {
    echo "WIF target parent has an unexpected mount boundary" >&2
    exit 78
  }
  if [ "$(findmnt -n -o TARGET -T "$parent")" = /run ]; then
    mount --bind "$parent" "$parent"
    parent_mount_created=true
    mount --make-private "$parent"
  fi
  [ "$(findmnt -n -o TARGET -T "$parent")" = "$parent" ] \
    && [ "$(findmnt -n -o FSTYPE -T "$parent")" = tmpfs ] \
    && [ "$(findmnt -n -o PROPAGATION -T "$parent")" = private ] || {
    echo "WIF target parent is not an isolated private tmpfs boundary" >&2
    exit 78
  }
fi
stage="$parent/.gcp-wif-stage-$$"
install -d -o 0 -g 0 -m 0700 "$stage"
mount -t tmpfs -o rw,nosuid,nodev,noexec,mode=0700,uid=20001,gid=20001,size=4m \
  tmpfs "$stage"
mounted=true
[ "$(findmnt -n -o FSTYPE -T "$stage")" = tmpfs ] || {
  echo "WIF staging mount is not tmpfs" >&2
  exit 1
}
node scripts/verify-gcp-wif-bundle.mjs copy "$source_dir" "$stage" "$audience_file"

install -d -o 20001 -g 20001 -m 0700 "$target"
mount --move "$stage" "$target"
mounted=false
published=true
[ "$(findmnt -n -o FSTYPE -T "$target")" = tmpfs ] || {
  echo "WIF target mount is not tmpfs" >&2
  exit 1
}
node scripts/verify-gcp-wif-bundle.mjs installed "$target" "$audience_file"
published=false
parent_mount_created=false
trap - EXIT HUP INT TERM
rmdir "$stage" >/dev/null 2>&1 || true
printf 'WIF tmpfs installation verified\n'
