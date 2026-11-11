#!/usr/bin/env bash
# Stamp version info into a COPY of the site (never the working tree):
#   scripts/stamp-version.sh <outdir>
# Reads <outdir>/version.txt (release-please; optional), writes <outdir>/version.json
# {version, commit, date, release} and replaces the footer label in <outdir>/index.html.
# Git facts come from the repository this script lives in; STAMP_COMMIT, STAMP_DATE and
# STAMP_TAG override them (used by tests/stamp-version.test.sh). Every value is validated
# before use; invalid values fail the run so a bad deploy never publishes.
set -euo pipefail
out=${1:-}
[ -n "$out" ] && [ -f "$out/index.html" ] || { echo "usage: $0 <outdir containing index.html>" >&2; exit 2; }
repo=$(cd "$(dirname "$0")/.." && pwd)

semver='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
version=0.0.0; have_version=0
if [ -f "$out/version.txt" ]; then
  version=$(tr -d '[:space:]' < "$out/version.txt")
  have_version=1
fi
[[ $version =~ $semver ]] || { echo "invalid version: $version" >&2; exit 1; }

commit=${STAMP_COMMIT:-$(git -C "$repo" rev-parse HEAD)}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit: $commit" >&2; exit 1; }
date=${STAMP_DATE:-$(TZ=UTC git -C "$repo" log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd HEAD)}
[[ $date =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "invalid date: $date" >&2; exit 1; }

if [ -n "${STAMP_TAG+x}" ]; then tag=$STAMP_TAG
else tag=$(git -C "$repo" describe --exact-match --tags --match 'v[0-9]*' HEAD 2>/dev/null || true); fi
release=false
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && release=true

short=${commit:0:7}
if [ $release = true ]; then label="v${tag#v}"
elif [ $have_version = 1 ]; then label="v$version+$short"
else label="dev+$short"; fi
[[ $label =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "invalid label: $label" >&2; exit 1; }

printf '{"version":"%s","commit":"%s","date":"%s","release":%s}\n' "$version" "$commit" "$date" "$release" > "$out/version.json"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed "/id=\"version\"/s|>dev</a>|>$label</a>|" "$out/index.html" > "$tmp"
grep -q ">$label</a>" "$tmp" || { echo "footer placeholder not found in $out/index.html" >&2; exit 1; }
cat "$tmp" > "$out/index.html"
echo "stamped $label ($commit, release=$release)"
