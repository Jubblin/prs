#!/usr/bin/env bash
# Network-free checks for scripts/stamp-version.sh, run on temp copies (the working tree is never stamped).
cd "$(dirname "$0")/.." || exit 1
fail=0; n=0
SHA=0123456789abcdef0123456789abcdef01234567; DATE=2026-11-11T10:00:00Z
no() { ! "$@"; }
ok() { n=$((n+1)); if ! "$@"; then echo "FAIL: check $n: $*"; fail=1; fi; }
mk() { d=$(mktemp -d); cp index.html "$d/"; [ -n "${1:-}" ] && echo "$1" > "$d/version.txt"; echo "$d"; }
run() { d=$1; shift; env STAMP_COMMIT="${C:-$SHA}" STAMP_DATE="${D:-$DATE}" "$@" bash scripts/stamp-version.sh "$d" >/dev/null 2>&1; }
has() { grep -q -- "$2" "$1"; }

d=$(mk 1.2.3); ok run "$d" STAMP_TAG=v1.2.3
ok has "$d/index.html" '>v1.2.3</a>'
ok has "$d/version.json" '"version":"1.2.3","commit":"'$SHA'","date":"'$DATE'","release":true'
d=$(mk 1.2.3); ok run "$d" STAMP_TAG=
ok has "$d/index.html" '>v1.2.3+0123456</a>'
ok has "$d/version.json" '"release":false'
d=$(mk); ok run "$d" STAMP_TAG=
ok has "$d/index.html" '>dev+0123456</a>'
ok has "$d/version.json" '"version":"0.0.0".*"release":false'
d=$(mk 1.2.3); ok run "$d" STAMP_TAG=v9.9
ok has "$d/version.json" '"release":false'
ok has index.html '>dev</a>'
ok test ! -e version.json
for v in '1.2' '1.2.3;rm' '$(id)' 'v1.2.3' '1.2.3|x'; do d=$(mk "$v"); ok no run "$d" STAMP_TAG=; done
C=zzz; d=$(mk 1.2.3); ok no run "$d" STAMP_TAG=; C=
D='2026-11-11'; d=$(mk 1.2.3); ok no run "$d" STAMP_TAG=; D=
d=$(mktemp -d); echo '<html></html>' > "$d/index.html"; ok no run "$d" STAMP_TAG=
ok no bash scripts/stamp-version.sh
ok no bash scripts/stamp-version.sh /nonexistent
d=$(mk 1.2.3); bash scripts/stamp-version.sh "$d" >/dev/null 2>&1; ok test -f "$d/version.json"
[ $fail = 0 ] && echo "stamp-version checks passed ($n)"
exit $fail
