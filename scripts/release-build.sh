#!/bin/sh
set -eu

mode=check
if [ "${1:-}" = "--build" ]; then
  mode=build
  shift
fi

revision="${1:-}"
manifest_path="${2:-}"
[ "$#" -eq 2 ] && [ -n "$revision" ] && [ -n "$manifest_path" ] || {
  echo "usage: $0 [--build] FULL_GIT_COMMIT RELEASE_MANIFEST_PATH" >&2
  exit 2
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "release build requires a Git worktree" >&2
  exit 2
}
cd "$repo_root"

scripts/release-check.sh
node scripts/verify-deployment-revision.mjs validate "$revision" >/dev/null
head_revision="$(git rev-parse --verify HEAD^{commit})"
[ "$revision" = "$head_revision" ] || {
  echo "release build BLOCKED: requested revision is not HEAD" >&2
  exit 1
}

tree_sha="$(git rev-parse --verify "$revision^{tree}")"
parent_sha="$(git rev-parse --verify "$revision^1")"

if [ "$mode" = check ]; then
  printf 'release build preflight PASS\ncommit sha: %s\ntree sha: %s\nparent commit: %s\n' \
    "$revision" "$tree_sha" "$parent_sha"
  printf 'no artifact was built; rerun with --build on the approved trusted build host\n'
  exit 0
fi

build_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
scripts/build-release-images.sh "$revision" "$manifest_path"

manifest_revision="$(node scripts/verify-deployment-revision.mjs manifest-revision "$manifest_path")"
[ "$manifest_revision" = "$revision" ] || {
  echo "release build BLOCKED: manifest revision mismatch" >&2
  exit 1
}

printf 'build timestamp: %s\ncommit sha: %s\ntree sha: %s\nparent commit: %s\n' \
  "$build_started_at" "$revision" "$tree_sha" "$parent_sha"
for component in api web strategyTools; do
  digest="$(node scripts/verify-deployment-revision.mjs manifest-image "$manifest_path" "$component")"
  printf 'artifact: xingheng-%s:%s\ndigest: %s\n' "$component" "$revision" "$digest"
done
