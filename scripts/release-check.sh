#!/bin/sh
set -eu

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
