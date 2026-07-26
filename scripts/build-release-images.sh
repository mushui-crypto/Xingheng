#!/bin/sh
set -eu
. "${0%/*}/trusted-operation-preamble.sh"

expected="${1:-}"
manifest_path="${2:-}"
[ "$#" -eq 2 ] && [ -n "$expected" ] && [ -n "$manifest_path" ] || {
  echo "usage: $0 FULL_GIT_COMMIT RELEASE_MANIFEST_PATH" >&2
  exit 2
}
platform="${XINGHENG_RELEASE_PLATFORM:-linux/amd64}"
[ "$platform" = linux/amd64 ] || {
  echo "release build platform must be linux/amd64" >&2
  exit 2
}

node scripts/verify-deployment-revision.mjs validate "$expected" >/dev/null

build_context="$(mktemp -d "${TMPDIR:-/tmp}/xingheng-release.XXXXXX")"
candidate_output_created=
pending=
cleanup_release_build() {
  rm -rf "$build_context"
  [ -z "$pending" ] || rm -f "$pending"
  if [ -n "$candidate_output_created" ]; then
    rm -f "$manifest_path"
    rm -f "${checksums:-}"
  fi
}
trap cleanup_release_build EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = release-build ]; then
  actual="${XINGHENG_RELEASE_CANDIDATE_REVISION:-}"
  candidate_root="${xingheng_entry_repo_root%/code}"
  [ "$expected" = "$actual" ] || {
    echo "release candidate revision mismatch" >&2
    exit 2
  }
  [ "$manifest_path" = "$candidate_root/release-manifest.json" ] || {
    echo "release candidate manifest path is not fixed" >&2
    exit 2
  }
  [ ! -e "$manifest_path" ] && [ ! -e "$candidate_root/RELEASE_SHA256SUMS" ] || {
    echo "release candidate output already exists" >&2
    exit 2
  }
  /usr/bin/tar -xf "$candidate_root/code.tar" -C "$build_context"
else
  actual="$(git rev-parse --verify HEAD^{commit} 2>/dev/null)" || {
    echo "release build requires a trusted Git checkout" >&2
    exit 2
  }
  node scripts/verify-deployment-revision.mjs validate "$actual" >/dev/null
  if [ "$expected" != "$actual" ]; then
    echo "release source revision mismatch" >&2
    exit 2
  fi
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo "release build requires a clean worktree" >&2
    exit 2
  fi
  git archive --format=tar "$actual" | tar -xf - -C "$build_context"
fi

export XINGHENG_REVISION="$actual"
XINGHENG_TRUSTED_DOCKER_PURPOSE=release-build
export XINGHENG_TRUSTED_DOCKER_PURPOSE
trusted_docker() {
  node scripts/trusted-docker.mjs "$@"
}
trusted_docker build --build-arg "XINGHENG_REVISION=$actual" --target api \
  --platform "$platform" --tag "xingheng-api:$actual" "$build_context"
trusted_docker build --build-arg "XINGHENG_REVISION=$actual" --target web \
  --platform "$platform" --tag "xingheng-web:$actual" "$build_context"
trusted_docker build --build-arg "XINGHENG_REVISION=$actual" --target strategy-tools \
  --platform "$platform" --tag "xingheng-strategy-tools:$actual" "$build_context"

api_digest="$(trusted_docker image inspect --format '{{.Id}}' "xingheng-api:$actual")"
web_digest="$(trusted_docker image inspect --format '{{.Id}}' "xingheng-web:$actual")"
strategy_digest="$(trusted_docker image inspect --format '{{.Id}}' "xingheng-strategy-tools:$actual")"
for image in \
  "xingheng-api:$actual" \
  "xingheng-web:$actual" \
  "xingheng-strategy-tools:$actual"
do
  [ "$(trusted_docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = "$platform" ] || {
    echo "release image platform mismatch" >&2
    exit 1
  }
done
if [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = release-build ]; then
  candidate_output_created=1
fi
node scripts/verify-deployment-revision.mjs write-manifest \
  "$manifest_path" "$actual" "$api_digest" "$web_digest" "$strategy_digest" >/dev/null
if [ "${XINGHENG_OPERATION_LOCK_CONTEXT:-}" = release-build ]; then
  node scripts/verify-deployment-revision.mjs candidate-images "$manifest_path"
  checksums="$candidate_root/RELEASE_SHA256SUMS"
  pending="$candidate_root/.RELEASE_SHA256SUMS.pending-$$"
  (
    cd "$candidate_root"
    /usr/bin/sha256sum code.tar candidate-build-receipt.json release-manifest.json
  ) > "$pending"
  chmod 0444 "$pending"
  mv "$pending" "$checksums"
  pending=
  candidate_output_created=
else
  node scripts/verify-deployment-revision.mjs images "$manifest_path"
fi
printf 'release images and manifest built for %s\n' "$actual"
