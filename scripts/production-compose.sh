#!/bin/sh
set -eu

if [ "${COMPOSE_FILE+x}" = x ] \
  || [ "${COMPOSE_PATH_SEPARATOR+x}" = x ] \
  || [ "${COMPOSE_PROJECT_NAME+x}" = x ]; then
  echo "production Compose control environment is not allowed" >&2
  exit 78
fi

validate_global_options() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file|--profile)
        [ "$#" -ge 2 ] || {
          echo "production Compose global option is incomplete" >&2
          return 78
        }
        shift 2
        ;;
      --env-file=*|--profile=*)
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

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(dirname -- "$script_dir")"
exec docker compose -f "$repo_root/compose.yaml" -p xingheng "$@"
