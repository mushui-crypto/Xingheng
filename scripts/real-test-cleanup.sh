#!/bin/sh
set -eu
umask 077

if [ "$(/usr/bin/id -u)" -eq 0 ] \
  && { [ "${HOME:-}" != /root ] || [ "${PATH:-}" != /usr/sbin:/usr/bin:/sbin:/bin ]; }; then
  echo "real-test cleanup root HOME/PATH boundary is invalid" >&2
  exit 78
fi
if /usr/bin/env | /usr/bin/grep -Eq '^(COMPOSE_|DOCKER_|NODE_OPTIONS=|NODE_PATH=|LD_|DYLD_|BASH_ENV=|ENV=|XDG_)' \
  || [ "${RELEASE_MANIFEST_FILE+x}" = x ]; then
  echo "real-test cleanup environment override is not allowed" >&2
  exit 78
fi
if [ "$(/usr/bin/id -u)" -eq 0 ] \
  && /usr/bin/env | /usr/bin/grep -Eq '^(NODE_ENV=|NODE_TEST_CONTEXT=|XINGHENG_TEST_)'; then
  echo "real-test cleanup test fixture environment is not allowed" >&2
  exit 78
fi

case "$0" in
  */*) ;;
  *) echo "real-test cleanup entry must be invoked by an explicit path" >&2; exit 78 ;;
esac
script_dir="$(CDPATH= cd -P -- "${0%/*}" && pwd -P)"
repo_root="${script_dir%/*}"
cd "$repo_root"

if [ "$(/usr/bin/id -u)" -eq 0 ] && [ -z "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" ]; then
  exec /usr/bin/env -i \
    HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    /usr/bin/node "$script_dir/trusted-operation-launcher.mjs" \
    real-test scripts/real-test-cleanup.sh "$@"
fi
[ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = real-test ] || {
  echo "real-test cleanup requires the trusted launcher" >&2
  exit 78
}
RELEASE_MANIFEST_FILE=deploy/release-manifest.json
export RELEASE_MANIFEST_FILE
. scripts/load-release-manifest.sh

exec /usr/bin/node scripts/realTestCleanup.mjs "$@"
