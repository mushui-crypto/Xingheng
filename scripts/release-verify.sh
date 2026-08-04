#!/bin/sh
set -eu

deployment=false
health_url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --deployment) deployment=true; shift ;;
    --health-url)
      [ "$#" -ge 2 ] || { echo "--health-url requires a URL" >&2; exit 2; }
      health_url="$2"
      shift 2
      ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

manifest_path="${1:-}"
[ "$#" -eq 1 ] && [ -n "$manifest_path" ] || {
  echo "usage: $0 [--deployment --health-url HTTPS_URL] RELEASE_MANIFEST_PATH" >&2
  exit 2
}
if [ "$deployment" = false ] && [ -n "$health_url" ]; then
  echo "--health-url requires --deployment" >&2
  exit 2
fi

revision="$(node scripts/verify-deployment-revision.mjs manifest-revision "$manifest_path")"
node scripts/verify-deployment-revision.mjs validate "$revision" >/dev/null

if git cat-file -e "$revision^{commit}" 2>/dev/null; then
  commit_sha="$(git rev-parse --verify "$revision^{commit}")"
  tree_sha="$(git rev-parse --verify "$revision^{tree}")"
  parent_sha="$(git rev-parse --verify "$revision^1")"
  [ "$commit_sha" = "$revision" ] || {
    echo "release verify BLOCKED: commit identity mismatch" >&2
    exit 1
  }
else
  echo "release verify BLOCKED: source commit is unavailable for tree verification" >&2
  exit 1
fi

node scripts/verify-deployment-revision.mjs images "$manifest_path"

if [ "$deployment" = true ]; then
  [ -n "$health_url" ] || {
    echo "release verify BLOCKED: production verification requires --health-url" >&2
    exit 1
  }
  node scripts/verify-deployment-revision.mjs env "$manifest_path" .env.production
  node scripts/verify-deployment-revision.mjs compose "$manifest_path" .env.production
  node scripts/verify-deployment-revision.mjs containers "$manifest_path"
  scripts/smoke.sh "$health_url"
fi

printf 'release verify PASS\ncommit sha: %s\ntree sha: %s\nparent commit: %s\n' \
  "$commit_sha" "$tree_sha" "$parent_sha"
for component in api web strategyTools; do
  digest="$(node scripts/verify-deployment-revision.mjs manifest-image "$manifest_path" "$component")"
  printf '%s digest: %s\n' "$component" "$digest"
done
if [ "$deployment" = true ]; then
  printf 'deployment revision: %s\nhealth check: PASS\n' "$revision"
else
  printf 'deployment revision: NOT_CHECKED\nhealth check: NOT_CHECKED\n'
fi
