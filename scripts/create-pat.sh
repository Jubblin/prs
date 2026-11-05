#!/usr/bin/env bash
# Open GitHub's pre-filled "new fine-grained token" page with the permissions
# the dashboard needs, then optionally check the pasted token works.
set -euo pipefail

name="PR dashboard"
expires=30
contents="write"
print_only=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Opens GitHub's pre-filled fine-grained token page (GitHub has no API to
create these tokens), then optionally validates the token you paste.

Options:
  --name NAME      Token name (default: "$name")
  --expires DAYS   Expiry in days (default: $expires)
  --no-merge       Request Contents: read instead of write (no merging)
  --print          Print the URL only; do not open a browser
  -h, --help       Show this help

Validation reads the token from GH_TOKEN, or prompts for it (hidden input).
The token is never written to disk or echoed.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) [ $# -ge 2 ] || { echo "--name needs a value" >&2; exit 2; }; name="$2"; shift 2 ;;
    --expires) [ $# -ge 2 ] || { echo "--expires needs a value" >&2; exit 2; }; expires="$2"; shift 2 ;;
    --no-merge) contents="read"; shift ;;
    --print) print_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$expires" in
  ''|*[!0-9]*) echo "--expires must be a number of days" >&2; exit 2 ;;
esac

urlencode() {
  local s="$1" i c out=""
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

description="Read/act on pull requests from the PR dashboard"
url="https://github.com/settings/personal-access-tokens/new"
url+="?name=$(urlencode "$name")"
url+="&description=$(urlencode "$description")"
url+="&expires_in=$expires"
url+="&pull_requests=write&issues=write&metadata=read&checks=read&statuses=read"
url+="&contents=$contents"

if [ "$print_only" -eq 1 ]; then
  echo "$url"
  exit 0
fi

if command -v xdg-open >/dev/null 2>&1; then
  opener=xdg-open
elif command -v open >/dev/null 2>&1; then
  opener=open
else
  opener=""
fi

if [ -n "$opener" ] && "$opener" "$url" >/dev/null 2>&1; then
  echo "Opened GitHub's token page in your browser."
else
  echo "Open this URL in your browser:"
  echo "$url"
fi

token="${GH_TOKEN:-}"
if [ -z "$token" ]; then
  if [ ! -t 0 ]; then
    exit 0
  fi
  echo "Choose your repositories, generate the token, then paste it below"
  echo "(leave empty to skip validation)."
  read -rs -p "Token: " token
  echo
fi
[ -n "$token" ] || exit 0

api() {
  curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com$1"
}

report() {
  if [ "$2" = "200" ]; then echo "  ok    $1"; else echo "  FAIL  $1 (HTTP $2)"; fi
}

user_code="$(api /user)"
report "authenticate (GET /user)" "$user_code"
if [ "$user_code" = "200" ]; then
  report "search PRs (GET /search/issues)" "$(api '/search/issues?q=is:pr+author:@me&per_page=1')"
fi
