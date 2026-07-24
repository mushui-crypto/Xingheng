#!/bin/sh
set -eu

expected="${1:-}"
manifest_path="${2:-}"
[ -n "$expected" ] && [ -n "$manifest_path" ] || {
  echo "usage: $0 FULL_GIT_COMMIT RELEASE_MANIFEST_PATH" >&2
  exit 2
}
actual="$(git rev-parse --verify HEAD^{commit} 2>/dev/null)" || {
  echo "release build requires a trusted Git checkout" >&2
  exit 2
}
platform="${XINGHENG_RELEASE_PLATFORM:-linux/amd64}"
[ "$platform" = linux/amd64 ] || {
  echo "release build platform must be linux/amd64" >&2
  exit 2
}

node scripts/verify-deployment-revision.mjs validate "$expected" >/dev/null
node scripts/verify-deployment-revision.mjs validate "$actual" >/dev/null
if [ "$expected" != "$actual" ]; then
  echo "release source revision mismatch" >&2
  exit 2
fi
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "release build requires a clean worktree" >&2
  exit 2
fi

build_context="$(mktemp -d "${TMPDIR:-/tmp}/xingheng-release.XXXXXX")"
trap 'rm -rf "$build_context"' EXIT HUP INT TERM
git archive --format=tar "$actual" | tar -xf - -C "$build_context"

export XINGHENG_REVISION="$actual"
docker build --build-arg "XINGHENG_REVISION=$actual" --target api \
  --platform "$platform" --tag "xingheng-api:$actual" "$build_context"
docker build --build-arg "XINGHENG_REVISION=$actual" --target web \
  --platform "$platform" --tag "xingheng-web:$actual" "$build_context"
docker build --build-arg "XINGHENG_REVISION=$actual" --target strategy-tools \
  --platform "$platform" --tag "xingheng-strategy-tools:$actual" "$build_context"

api_digest="$(docker image inspect --format '{{.Id}}' "xingheng-api:$actual")"
web_digest="$(docker image inspect --format '{{.Id}}' "xingheng-web:$actual")"
strategy_digest="$(docker image inspect --format '{{.Id}}' "xingheng-strategy-tools:$actual")"
for image in \
  "xingheng-api:$actual" \
  "xingheng-web:$actual" \
  "xingheng-strategy-tools:$actual"
do
  [ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = "$platform" ] || {
    echo "release image platform mismatch" >&2
    exit 1
  }
done
node scripts/verify-deployment-revision.mjs write-manifest \
  "$manifest_path" "$actual" "$api_digest" "$web_digest" "$strategy_digest" >/dev/null
node scripts/verify-deployment-revision.mjs images "$manifest_path"
printf 'release images and manifest built for %s\n' "$actual"
