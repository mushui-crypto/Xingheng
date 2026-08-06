#!/bin/sh
set -eu

case "$0" in
  */*) ;;
  *) echo "input_invalid" >&2; exit 1 ;;
esac
script_dir="$(CDPATH= cd -P -- "${0%/*}" && pwd -P)"
repo_root="${script_dir%/*}"
case "$repo_root" in
  /opt/xingheng-release/candidates/*/code) ;;
  *) echo "candidate_identity_invalid" >&2; exit 1 ;;
esac
candidate_root="${repo_root%/code}"
candidate_revision="${candidate_root##*/}"
case "$candidate_revision" in
  *[!0-9a-f]*|"") echo "candidate_identity_invalid" >&2; exit 1 ;;
esac
[ "${#candidate_revision}" -eq 40 ] || { echo "candidate_identity_invalid" >&2; exit 1; }

[ "$#" -eq 1 ] || { echo "input_invalid" >&2; exit 1; }
case "$1" in
  rwa-automation-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.rwa.enc.json) ;;
  *) echo "input_invalid" >&2; exit 1 ;;
esac

if [ "$(/usr/bin/id -u)" -ne 0 ] || [ "$(/usr/bin/id -g)" -ne 0 ]; then
  echo "candidate_identity_invalid" >&2
  exit 1
fi
if [ "${HOME:-}" != /root ] || [ "${PATH:-}" != /usr/sbin:/usr/bin:/sbin:/bin ]; then
  echo "candidate_identity_invalid" >&2
  exit 1
fi
if /usr/bin/env | /usr/bin/grep -Eq \
  '^(COMPOSE_|DOCKER_|DOMAIN=|NODE_OPTIONS=|NODE_PATH=|NODE_ENV=|NODE_TEST_CONTEXT=|LD_|DYLD_|BASH_ENV=|ENV=|XDG_|XINGHENG_TEST_|XINGHENG_WIF_HOST_PATH=|RWA_|GOOGLE_)'; then
  echo "candidate_identity_invalid" >&2
  exit 1
fi

case "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" in
  candidate-verify)
    [ "${XINGHENG_RELEASE_CANDIDATE_REVISION:-}" = "$candidate_revision" ] || {
      echo "candidate_identity_invalid" >&2
      exit 1
    }
    ;;
  "")
    exec /usr/bin/env -i \
      HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
      /usr/bin/node "$script_dir/trusted-operation-launcher.mjs" \
      candidate-verify scripts/candidate-rwa-automation-verify.sh "$1"
    ;;
  *) echo "candidate_identity_invalid" >&2; exit 1 ;;
esac

exec /usr/bin/node "$script_dir/candidateRwaAutomationVerify.mjs" "$1"
