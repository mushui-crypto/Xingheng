#!/bin/sh

case "$0" in
  */*) ;;
  *) echo "trusted operation entry must be invoked by an explicit path" >&2; exit 78 ;;
esac
xingheng_entry_script_dir="$(CDPATH= cd -P -- "${0%/*}" && pwd -P)"
xingheng_entry_repo_root="${xingheng_entry_script_dir%/*}"
cd "$xingheng_entry_repo_root"

if [ "$(/usr/bin/id -u)" -eq 0 ]; then
  if [ "${HOME:-}" != /root ] || [ "${PATH:-}" != /usr/sbin:/usr/bin:/sbin:/bin ]; then
    echo "trusted production root HOME/PATH boundary is invalid" >&2
    exit 78
  fi
  if /usr/bin/env | /usr/bin/grep -Eq \
    '^(COMPOSE_|DOCKER_|NODE_OPTIONS=|NODE_PATH=|NODE_ENV=|NODE_TEST_CONTEXT=|LD_|DYLD_|BASH_ENV=|ENV=|XDG_|XINGHENG_TEST_)'; then
    echo "trusted production operation environment is not allowed" >&2
    exit 78
  fi
  case "$xingheng_entry_repo_root" in
    /opt/xingheng-release/candidates/*/code)
      xingheng_expected_operation=release-build
      [ "${0##*/}" = build-release-images.sh ] || {
        echo "trusted candidate operation entry is invalid" >&2
        exit 78
      }
      ;;
    /opt/xingheng-release/code)
      if [ "${0##*/}" = install-gcp-wif.sh ]; then
        case "${1:-}" in
          production) xingheng_expected_operation=production ;;
          *) echo "WIF installation environment is invalid" >&2; exit 78 ;;
        esac
      else
        xingheng_expected_operation=production
      fi
      ;;
    *)
      echo "trusted operation root is invalid" >&2
      exit 78
      ;;
  esac
  case "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" in
    "$xingheng_expected_operation") ;;
    "")
      exec /usr/bin/env -i \
        HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
        /usr/bin/node "$xingheng_entry_script_dir/trusted-operation-launcher.mjs" \
        "$xingheng_expected_operation" "scripts/${0##*/}" "$@"
      ;;
    *)
      echo "trusted production operation lock context is invalid" >&2
      exit 78
      ;;
  esac
fi
