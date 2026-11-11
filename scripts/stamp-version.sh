#!/usr/bin/env bash
# Stamp version info into a COPY of the site (never the working tree):
#   scripts/stamp-version.sh <outdir>
# Reads the version from <outdir>/version.txt, else the release-please manifest, else the nearest tag, else 0.0.0; writes <outdir>/version.json
# {version, commit, date, release} and replaces the footer label in <outdir>/index.html.
# Git facts come from the repository this script lives in; STAMP_COMMIT, STAMP_DATE and
# STAMP_TAG (exact tag) and STAMP_NEAREST_TAG override them (used by tests/stamp-version.test.sh). Every value is validated
# before use; invalid values fail the run so a bad deploy never publishes.
set -euo pipefail
out=${1:-}
[ -n "$out" ] && [ -f "$out/index.html" ] || { echo "usage: $0 <outdir containing index.html>" >&2; exit 2; }
repo=$(cd "$(dirname "$0")/.." && pwd)

semver='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
# Version source order: (1) <outdir>/version.txt, (2) the "." entry of
# <outdir>/.release-please-manifest.json, (3) the nearest reachable vX.Y.Z tag, (4) 0.0.0.
# (release-please's "simple" strategy never creates version.txt, so in practice the
# manifest, which the release PR bumps on main, is the source.) A present but invalid
# version.txt fails loudly. A manifest without a valid "." entry, or an invalid tag, is
# skipped (the next source is used); file content is only ever matched against the strict
# regex and never reaches eval, sed or the shell unvalidated.
version=0.0.0; have_version=0
if [ -f "$out/version.txt" ]; then
  version=$(tr -d '[:space:]' < "$out/version.txt")
  have_version=1
elif [ -f "$out/.release-please-manifest.json" ]; then
  manifest=$(tr -d '[:space:]' < "$out/.release-please-manifest.json" | head -c 4096)
  if [[ $manifest =~ \"\.\":\"([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)\" ]]; then
    version=${BASH_REMATCH[1]}; have_version=1
  else
    echo "warning: no valid \".\" version in .release-please-manifest.json; ignoring it" >&2
  fi
fi
if [ $have_version = 0 ]; then
  if [ -n "${STAMP_NEAREST_TAG+x}" ]; then near=$STAMP_NEAREST_TAG
  else near=$(git -C "$repo" describe --tags --match 'v[0-9]*' --abbrev=0 HEAD 2>/dev/null || true); fi
  if [[ $near =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then version=${BASH_REMATCH[1]}; have_version=1; fi
fi
[[ $version =~ $semver ]] || { echo "invalid version: $version" >&2; exit 1; }

commit=${STAMP_COMMIT:-$(git -C "$repo" rev-parse HEAD)}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit: $commit" >&2; exit 1; }
date=${STAMP_DATE:-$(TZ=UTC git -C "$repo" log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd HEAD)}
[[ $date =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "invalid date: $date" >&2; exit 1; }

if [ -n "${STAMP_TAG+x}" ]; then tag=$STAMP_TAG
else tag=$(git -C "$repo" describe --exact-match --tags --match 'v[0-9]*' HEAD 2>/dev/null || true); fi
release=false
if [[ $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then release=true; version=${BASH_REMATCH[1]}; fi

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
