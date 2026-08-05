#!/bin/sh
set -eu

if [ -x /usr/bin/realpath ]; then
  realpath_tool=/usr/bin/realpath
elif [ -x /bin/realpath ]; then
  realpath_tool=/bin/realpath
else
  echo "release promotion entry identity cannot be resolved" >&2
  exit 78
fi
entry_reference=$0
case "$entry_reference" in
  */*) ;;
  ''|-*|*[!A-Za-z0-9._-]*)
    echo "release promotion entry identity is invalid" >&2
    exit 78
    ;;
  *)
    if [ -f "./$entry_reference" ] || [ -L "./$entry_reference" ]; then
      entry_reference="./$entry_reference"
    else
      entry_reference=$(command -v "$entry_reference") || {
        echo "release promotion entry identity cannot be resolved" >&2
        exit 78
      }
    fi
    ;;
esac
entry_path=$($realpath_tool -- "$entry_reference") || {
  echo "release promotion entry identity cannot be resolved" >&2
  exit 78
}
[ -f "$entry_path" ] && [ "${entry_path##*/}" = release-promote.sh ] || {
  echo "release promotion entry identity is invalid" >&2
  exit 78
}
script_dir=${entry_path%/*}
repo_root=${script_dir%/*}

trusted_boundary=false
if [ "$(/usr/bin/id -u)" -eq 0 ] \
  || [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = promotion ]; then
  trusted_boundary=true
fi
case "$repo_root" in
  /opt/xingheng-release/candidates/*/code) trusted_boundary=true ;;
esac

if [ "$trusted_boundary" = true ]; then
  case "${1:-}" in --promotion-json|--terminalize-unknown) ;; *)
    echo "trusted promotion command is invalid" >&2
    exit 78
    ;;
  esac
fi

case "${1:-}" in
  --promotion-json|--terminalize-unknown)
    case "$repo_root" in /opt/xingheng-release/candidates/*/code) ;; *)
      echo "promotion entry must run from a trusted candidate" >&2
      exit 78
      ;;
    esac
    if [ "$(/usr/bin/id -u)" -eq 0 ] && [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" != promotion ]; then
      exec /usr/bin/env -i HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin \
        LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
        /usr/bin/node "$script_dir/trusted-operation-launcher.mjs" \
        promotion scripts/release-promote.sh "$@"
    fi
    [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = promotion ] || {
      echo "promotion lock context is invalid" >&2
      exit 78
    }
    [ "${OLDPWD+x}" != x ] || {
      echo "trusted promotion environment is invalid" >&2
      exit 78
    }
    cd "$repo_root"
    unset OLDPWD
    [ "${PWD:-}" = "$repo_root" ] || { echo "trusted promotion cwd is invalid" >&2; exit 78; }
    if /usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/grep -Ev \
      '^(HOME|PATH|LANG|LC_ALL|TZ|PWD|SHLVL|_|XINGHENG_OPERATION_LOCK_CONTEXT|XINGHENG_RELEASE_CANDIDATE_REVISION|XINGHENG_TRUSTED_OPERATION_ENTRY)$' \
      | /usr/bin/grep -q .; then
      echo "trusted promotion environment is invalid" >&2
      exit 78
    fi
    [ "${XINGHENG_TRUSTED_OPERATION_ENTRY:-}" = release-promote.sh ] || {
      echo "trusted promotion wrapper identity is invalid" >&2
      exit 78
    }
    case "$1" in
      --promotion-json)
        [ "$#" -eq 2 ] || { echo "--promotion-json requires one base64url payload" >&2; exit 2; }
        case "$2" in *[!A-Za-z0-9_-]*|'') echo "promotion payload encoding is invalid" >&2; exit 2;; esac
        exec /usr/bin/node "$script_dir/releasePromotionTransaction.mjs" promote "$2"
        ;;
      --terminalize-unknown)
        [ "$#" -eq 2 ] || { echo "--terminalize-unknown requires one operation ID" >&2; exit 2; }
        exec /usr/bin/node "$script_dir/releasePromotionTransaction.mjs" terminalize-unknown "$2"
        ;;
    esac
    ;;
esac

mode=check
if [ "${1:-}" = "--generate" ]; then
  mode=generate
  shift
fi

archive=false
archive_root=
archive_candidate_manifest=
archive_revision=
archive_parent=
archive_source_sha256=
archive_tree_sha256=
archive_manifest_sha256=
if [ "${1:-}" = --archive ]; then
  [ "$#" -eq 16 ] || {
    echo "--archive requires CANDIDATE_ROOT CANDIDATE_MANIFEST REVISION PARENT_COMMIT SOURCE_SHA256 TREE_SHA256 MANIFEST_SHA256" >&2
    exit 2
  }
  archive=true
  archive_root="$2"
  archive_candidate_manifest="$3"
  archive_revision="$4"
  archive_parent="$5"
  archive_source_sha256="$6"
  archive_tree_sha256="$7"
  archive_manifest_sha256="$8"
  shift 8
fi

version="${1:-}"
manifest_path="${2:-}"
environment="${3:-}"
test_status="${4:-}"
security_status="${5:-}"
approval_status="${6:-}"
rollback_point="${7:-}"
health_url="${8:-}"
[ "$#" -eq 8 ] || {
  echo "usage: $0 [--generate] [--archive CANDIDATE_ROOT CANDIDATE_MANIFEST REVISION PARENT_COMMIT SOURCE_SHA256 TREE_SHA256 MANIFEST_SHA256] VERSION CANONICAL_MANIFEST_PATH ENVIRONMENT TEST_STATUS SECURITY_STATUS APPROVAL_STATUS ROLLBACK_POINT HEALTH_URL" >&2
  exit 2
}

case "$version" in
  ''|*[!A-Za-z0-9._-]*) echo "version contains unsupported characters" >&2; exit 2 ;;
esac
[ "$environment" = production ] || {
  echo "release promotion BLOCKED: formal promotion environment must be production" >&2
  exit 1
}
for status in "$test_status" "$security_status" "$approval_status"; do
  [ "$status" = PASS ] || {
    echo "release promotion BLOCKED: test, security and approval status must all be PASS" >&2
    exit 1
  }
done
[ -n "$rollback_point" ] && [ "$rollback_point" != UNKNOWN ] && [ "$rollback_point" != BLOCKED ] || {
  echo "release promotion BLOCKED: a verified rollback point is required" >&2
  exit 1
}
case "$rollback_point" in
  *'
'*|*'`'*) echo "release promotion BLOCKED: rollback point contains unsafe characters" >&2; exit 2 ;;
esac
case "$health_url" in
  https://*) ;;
  *) echo "release promotion BLOCKED: production health URL must use HTTPS" >&2; exit 1 ;;
esac

if [ "$archive" = true ]; then
  verify_output="$(scripts/release-verify.sh --archive \
    "$archive_root" "$archive_candidate_manifest" "$archive_revision" "$archive_parent" \
    "$archive_source_sha256" "$archive_tree_sha256" "$archive_manifest_sha256" \
    --deployment --health-url "$health_url" "$manifest_path")"
else
  scripts/release-check.sh
  verify_output="$(scripts/release-verify.sh --deployment --health-url "$health_url" "$manifest_path")"
fi
revision="$(node scripts/verify-deployment-revision.mjs manifest-revision "$manifest_path")"
if [ "$archive" = true ]; then
  [ "$revision" = "$archive_revision" ] || {
    echo "release promotion BLOCKED: archive revision mismatch" >&2
    exit 1
  }
  tree_sha="$archive_tree_sha256"
  parent_sha="$archive_parent"
else
  tree_sha="$(git rev-parse --verify "$revision^{tree}")"
  parent_sha="$(git rev-parse --verify "$revision^1")"
fi
api_digest="$(node scripts/verify-deployment-revision.mjs manifest-image "$manifest_path" api)"
web_digest="$(node scripts/verify-deployment-revision.mjs manifest-image "$manifest_path" web)"
strategy_digest="$(node scripts/verify-deployment-revision.mjs manifest-image "$manifest_path" strategyTools)"

if [ "$mode" = check ]; then
  printf '%s\n' "$verify_output"
  printf 'production gate PASS\nversion: %s\nrollback point: %s\n' "$version" "$rollback_point"
  printf 'no release audit manifest was generated; rerun with --generate after human approval\n'
  exit 0
fi

output="RELEASE_${version}.md"
[ ! -e "$output" ] && [ ! -L "$output" ] || {
  echo "release promotion BLOCKED: $output already exists" >&2
  exit 1
}
generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

umask 022
set -C
{
  printf '# Release %s\n\n' "$version"
  printf -- '- status: `PASS`\n'
  printf -- '- release classification: `production release`\n'
  printf -- '- generated at: `%s`\n\n' "$generated_at"
  printf '## Identity\n\n'
  printf -- '- version: `%s`\n' "$version"
  printf -- '- commit sha: `%s`\n' "$revision"
  if [ "$archive" = true ]; then
    printf -- '- candidate tree sha256: `%s`\n' "$tree_sha"
    printf -- '- source archive sha256: `%s`\n' "$archive_source_sha256"
    printf -- '- release manifest sha256: `%s`\n' "$archive_manifest_sha256"
  else
    printf -- '- tree sha: `%s`\n' "$tree_sha"
  fi
  printf -- '- parent commit: `%s`\n' "$parent_sha"
  printf -- '- environment: `%s`\n\n' "$environment"
  printf '## Artifact digests\n\n'
  printf -- '- xingheng-api: `%s`\n' "$api_digest"
  printf -- '- xingheng-web: `%s`\n' "$web_digest"
  printf -- '- xingheng-strategyTools: `%s`\n\n' "$strategy_digest"
  printf '## Acceptance\n\n'
  printf -- '- test status: `%s`\n' "$test_status"
  printf -- '- security status: `%s`\n' "$security_status"
  printf -- '- approval status: `%s`\n\n' "$approval_status"
  printf '## Production Gate\n\n'
  printf -- '- commit identity: `PASS`\n'
  printf -- '- tree identity: `PASS`\n'
  printf -- '- artifact digest: `PASS`\n'
  printf -- '- deployment revision: `PASS` (`%s`)\n' "$revision"
  printf -- '- health check: `PASS`\n'
  printf -- '- rollback point: `PASS` (`%s`)\n\n' "$rollback_point"
  printf 'This manifest records release identity only. It does not grant provider, permit, trading, position, or funds authorization.\n'
} > "$output"
set +C

printf '%s\n' "$verify_output"
printf 'production gate PASS\nrelease audit manifest generated: %s\n' "$output"
