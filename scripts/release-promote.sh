#!/bin/sh
set -eu

mode=check
if [ "${1:-}" = "--generate" ]; then
  mode=generate
  shift
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
  echo "usage: $0 [--generate] VERSION RELEASE_MANIFEST_PATH ENVIRONMENT TEST_STATUS SECURITY_STATUS APPROVAL_STATUS ROLLBACK_POINT HEALTH_URL" >&2
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

scripts/release-check.sh
verify_output="$(scripts/release-verify.sh --deployment --health-url "$health_url" "$manifest_path")"
revision="$(node scripts/verify-deployment-revision.mjs manifest-revision "$manifest_path")"
tree_sha="$(git rev-parse --verify "$revision^{tree}")"
parent_sha="$(git rev-parse --verify "$revision^1")"
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
  printf -- '- tree sha: `%s`\n' "$tree_sha"
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
