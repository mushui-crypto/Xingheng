#!/bin/sh
set -eu
umask 077

if [ "$(/usr/bin/id -u)" -eq 0 ] \
  && { [ "${HOME:-}" != /root ] || [ "${PATH:-}" != /usr/sbin:/usr/bin:/sbin:/bin ]; }; then
  echo "production root HOME/PATH boundary is invalid" >&2
  exit 78
fi
if /usr/bin/env | /usr/bin/grep -Eq '^(COMPOSE_|DOCKER_|NODE_OPTIONS=|NODE_PATH=|LD_|DYLD_|BASH_ENV=|ENV=|XDG_)'; then
  echo "production Docker and Compose control environment is not allowed" >&2
  exit 78
fi
if [ "$(/usr/bin/id -u)" -eq 0 ] \
  && /usr/bin/env | /usr/bin/grep -Eq '^(NODE_ENV=|NODE_TEST_CONTEXT=|XINGHENG_TEST_)'; then
  echo "production test fixture environment is not allowed" >&2
  exit 78
fi

validate_global_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file|--env-file=*|--profile)
        case "$1" in
          --env-file|--env-file=*)
            echo "production Compose env file override is not allowed" >&2
            return 78
            ;;
        esac
        [ "$#" -ge 2 ] || {
          echo "production Compose global option is incomplete" >&2
          return 78
        }
        shift 2
        ;;
      --profile=*)
        shift
        ;;
      config|up|run|exec|stop|ps|logs|down)
        return 0
        ;;
      -f*|-p*|--file|--file=*|--project-name|--project-name=*|--project-directory|--project-directory=*)
        echo "production Compose topology override is not allowed" >&2
        return 78
        ;;
      *)
        echo "production Compose global option is not allowed" >&2
        return 78
        ;;
    esac
  done
  echo "production Compose subcommand is required" >&2
  return 78
}

validate_global_options "$@"

case "$0" in
  */*) ;;
  *) echo "production Compose entry must be invoked by an explicit path" >&2; exit 78 ;;
esac
script_dir="$(CDPATH= cd -P -- "${0%/*}" && pwd -P)"
repo_root="${script_dir%/*}"
cd "$repo_root"
if [ "$(/usr/bin/id -u)" -eq 0 ]; then
  if [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" != production ]; then
    [ -z "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" ] || {
      echo "production inherited operation lock context is invalid" >&2
      exit 78
    }
    exec /usr/bin/env -i \
      HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
      XINGHENG_REVISION="${XINGHENG_REVISION:-}" \
      XINGHENG_API_IMAGE="${XINGHENG_API_IMAGE:-}" \
      XINGHENG_WEB_IMAGE="${XINGHENG_WEB_IMAGE:-}" \
      XINGHENG_STRATEGY_TOOLS_IMAGE="${XINGHENG_STRATEGY_TOOLS_IMAGE:-}" \
      /usr/bin/node "$script_dir/trusted-operation-launcher.mjs" \
      production scripts/production-compose.sh "$@"
  fi
  exec /usr/bin/env -i \
    HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    XINGHENG_OPERATION_LOCK_CONTEXT=production \
    XINGHENG_REVISION="${XINGHENG_REVISION:-}" \
    XINGHENG_API_IMAGE="${XINGHENG_API_IMAGE:-}" \
    XINGHENG_WEB_IMAGE="${XINGHENG_WEB_IMAGE:-}" \
    XINGHENG_STRATEGY_TOOLS_IMAGE="${XINGHENG_STRATEGY_TOOLS_IMAGE:-}" \
    /usr/bin/node "$script_dir/verify-compose-environment-file.mjs" production "$@"
fi
exec node "$script_dir/verify-compose-environment-file.mjs" production "$@"
