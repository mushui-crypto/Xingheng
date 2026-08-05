#!/bin/sh
set -eu

if [ "${1:-}" = --archive ]; then
  [ "$#" -eq 8 ] || {
    echo "usage: $0 --archive CANDIDATE_ROOT RELEASE_MANIFEST REVISION PARENT_COMMIT SOURCE_SHA256 TREE_SHA256 MANIFEST_SHA256" >&2
    exit 2
  }
  candidate_root="$2"
  manifest_path="$3"
  revision="$4"
  parent_commit="$5"
  source_sha256="$6"
  tree_sha256="$7"
  manifest_sha256="$8"
  for value in "$revision" "$parent_commit"; do
    case "$value" in
      *[!0-9a-f]*|'') echo "release archive revision metadata is invalid" >&2; exit 2 ;;
    esac
    [ "${#value}" -eq 40 ] || {
      echo "release archive revision metadata is invalid" >&2
      exit 2
    }
  done
  [ "$revision" != "$parent_commit" ] || {
    echo "release archive revision metadata is invalid" >&2
    exit 2
  }
  for value in "$source_sha256" "$tree_sha256" "$manifest_sha256"; do
    case "$value" in
      *[!0-9a-f]*|'') echo "release archive SHA-256 metadata is invalid" >&2; exit 2 ;;
    esac
    [ "${#value}" -eq 64 ] || {
      echo "release archive SHA-256 metadata is invalid" >&2
      exit 2
    }
  done
  [ "$candidate_root" = "/opt/xingheng-release/candidates/$revision" ] || {
    echo "release archive candidate root is not canonical" >&2
    exit 1
  }
  [ "$manifest_path" = "$candidate_root/release-manifest.json" ] || {
    echo "release archive manifest path is not canonical" >&2
    exit 1
  }
  [ -f "$manifest_path" ] && [ ! -L "$manifest_path" ] || {
    echo "release archive manifest boundary is invalid" >&2
    exit 1
  }
  actual_source_sha256="$(/usr/bin/sha256sum "$candidate_root/code.tar" | awk '{print $1}')" || {
    echo "release archive source SHA-256 validation failed" >&2
    exit 1
  }
  [ "$actual_source_sha256" = "$source_sha256" ] || {
    echo "release archive source SHA-256 mismatch" >&2
    exit 1
  }
  actual_manifest_sha256="$(/usr/bin/sha256sum "$manifest_path" | awk '{print $1}')" || {
    echo "release archive manifest SHA-256 validation failed" >&2
    exit 1
  }
  [ "$actual_manifest_sha256" = "$manifest_sha256" ] || {
    echo "release archive manifest SHA-256 mismatch" >&2
    exit 1
  }
  identity="$({
    /usr/bin/node --input-type=module -e '
import { pathToFileURL } from "node:url";

const candidateRoot = process.argv[1];
const revision = process.argv[2];
const moduleUrl = pathToFileURL(
  `${candidateRoot}/code/scripts/candidateRwaAutomationVerify.mjs`,
).href;
const { readCandidateIdentity } = await import(moduleUrl);
const value = readCandidateIdentity(`${candidateRoot}/code`, revision);
process.stdout.write([
  value.revision,
  value.archiveSha256,
  value.treeSha256,
  value.manifestSha256,
  value.checksumsSha256,
].join("\n"));
' "$candidate_root" "$revision"
  } 2>&1)" || {
    echo "release archive identity validation failed" >&2
    exit 1
  }
  set -- $identity
  [ "$#" -eq 5 ] \
    && [ "$1" = "$revision" ] \
    && [ "$2" = "$source_sha256" ] \
    && [ "$3" = "$tree_sha256" ] \
    && [ "$4" = "$manifest_sha256" ] || {
    echo "release archive identity mismatch" >&2
    exit 1
  }
  printf 'release check PASS: archive identity is complete and exact\n'
  printf 'commit sha: %s\nparent commit: %s\nsource sha256: %s\ncandidate tree sha256: %s\nmanifest sha256: %s\nchecksums sha256: %s\n' \
    "$revision" "$parent_commit" "$source_sha256" "$tree_sha256" "$manifest_sha256" "$5"
  exit 0
fi

[ "$#" -eq 0 ] || {
  echo "usage: $0 | $0 --archive CANDIDATE_ROOT RELEASE_MANIFEST REVISION PARENT_COMMIT SOURCE_SHA256 TREE_SHA256 MANIFEST_SHA256" >&2
  exit 2
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "release check requires a Git worktree" >&2
  exit 2
}
cd "$repo_root"

echo "== git status =="
git status --short

echo "== git diff --check =="
git diff --check
git diff --cached --check

echo "== git diff --stat =="
git diff --stat
git diff --cached --stat

changed_paths="$({
  git diff --name-only
  git diff --cached --name-only
  git ls-files --others --exclude-standard
} | LC_ALL=C sort -u)"

sensitive_paths="$(printf '%s\n' "$changed_paths" | awk '
  {
    path = tolower($0)
    if (path ~ /(^|\/)\.env($|\.)/ && path !~ /(\.example|\.sample|\.template)$/) {
      print
      next
    }
    if (path ~ /(^|\/)(id_rsa|id_ed25519|credentials?|secrets?)(\.|$|\/)/) {
      print
      next
    }
    if (path ~ /\.(pem|key|p12|pfx|jks|keystore)$/) {
      print
      next
    }
    if (path ~ /(^|\/)(wallet|mnemonic|private[-_]?key)(\.|$|\/)/) {
      print
      next
    }
  }
')"

failed=0
if [ -n "$sensitive_paths" ]; then
  echo "sensitive file names detected in changed paths:" >&2
  printf '%s\n' "$sensitive_paths" >&2
  failed=1
fi

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "release check BLOCKED: worktree contains uncommitted or untracked files" >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "release check PASS: worktree is clean and no changed sensitive file names were detected"
