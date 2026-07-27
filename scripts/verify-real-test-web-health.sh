#!/bin/sh
set -eu

protocol="${1:-}"
domain="${2:-}"
revision="${3:-}"
case "$protocol" in
  http|https) ;;
  *) exit 1 ;;
esac
case "$domain" in
  ""|*[!A-Za-z0-9.-]*|.*|*..*|*.) exit 1 ;;
esac
case "$revision" in
  *[!0-9a-f]*|"") exit 1 ;;
esac
[ "${#revision}" -eq 40 ] || exit 1

body="$(mktemp)"
headers="$(mktemp)"
cleanup() {
  rm -f "$body" "$headers"
}
trap cleanup EXIT HUP INT TERM

tls_option=""
[ "$protocol" = http ] || tls_option="--no-check-certificate"
wget -qO "$body" --server-response $tls_option \
  --header "Host: $domain" "$protocol://127.0.0.1/api/health" 2>"$headers"

[ "$(grep -Eic '^[[:space:]]*Cache-Control:[[:space:]]*no-store\r?$' "$headers")" -eq 1 ]
for field in \
  '"deploymentEnvironment":"real-test"' \
  '"composeProject":"xingheng-real-test"' \
  "\"revision\":\"$revision\""
do
  [ "$(grep -oF "$field" "$body" | wc -l | tr -d ' ')" -eq 1 ]
done
