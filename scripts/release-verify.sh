#!/bin/sh
set -eu

archive=false
archive_root=
archive_candidate_manifest=
archive_revision=
archive_parent=
archive_source_sha256=
archive_tree_sha256=
archive_manifest_sha256=
if [ "${1:-}" = --archive ]; then
  [ "$#" -ge 9 ] || {
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
  echo "usage: $0 [--archive CANDIDATE_ROOT CANDIDATE_MANIFEST REVISION PARENT_COMMIT SOURCE_SHA256 TREE_SHA256 MANIFEST_SHA256] [--deployment --health-url HTTPS_URL] CANONICAL_MANIFEST_PATH" >&2
  exit 2
}
if [ "$deployment" = false ] && [ -n "$health_url" ]; then
  echo "--health-url requires --deployment" >&2
  exit 2
fi

if [ "$archive" = true ]; then
  [ "$archive_candidate_manifest" != "$manifest_path" ] || {
    echo "release verify BLOCKED: candidate manifest cannot be used as canonical manifest" >&2
    exit 1
  }
  scripts/release-check.sh --archive \
    "$archive_root" "$archive_candidate_manifest" "$archive_revision" "$archive_parent" \
    "$archive_source_sha256" "$archive_tree_sha256" "$archive_manifest_sha256" >/dev/null
fi

revision="$(node scripts/verify-deployment-revision.mjs manifest-revision "$manifest_path")"
node scripts/verify-deployment-revision.mjs validate "$revision" >/dev/null

if [ "$archive" = true ]; then
  [ "$revision" = "$archive_revision" ] || {
    echo "release verify BLOCKED: archive revision mismatch" >&2
    exit 1
  }
  canonical_manifest_sha256="$(/usr/bin/sha256sum "$manifest_path" | awk '{print $1}')"
  [ "$canonical_manifest_sha256" = "$archive_manifest_sha256" ] || {
    echo "release verify BLOCKED: canonical manifest identity mismatch" >&2
    exit 1
  }
  commit_sha="$archive_revision"
  tree_sha="$archive_tree_sha256"
  parent_sha="$archive_parent"
elif git cat-file -e "$revision^{commit}" 2>/dev/null; then
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
if [ "$archive" = true ]; then
  printf 'source sha256: %s\nmanifest sha256: %s\ntree identity type: candidate-tree-sha256\n' \
    "$archive_source_sha256" "$archive_manifest_sha256"
fi
for component in api web strategyTools; do
  digest="$(node scripts/verify-deployment-revision.mjs manifest-image "$manifest_path" "$component")"
  printf '%s digest: %s\n' "$component" "$digest"
done
if [ "$deployment" = true ]; then
  printf 'deployment revision: %s\nhealth check: PASS\n' "$revision"
else
  printf 'deployment revision: NOT_CHECKED\nhealth check: NOT_CHECKED\n'
fi
