#!/usr/bin/env bash
# Network-free checks for scripts/stamp-version.sh, run on temp copies (the working tree is never stamped).
cd "$(dirname "$0")/.." || exit 1
fail=0; n=0
SHA=0123456789abcdef0123456789abcdef01234567; DATE=2026-11-11T10:00:00Z
no() { ! "$@"; }
ok() { n=$((n+1)); if ! "$@"; then echo "FAIL: check $n: $*"; fail=1; fi; }
mk() { d=$(mktemp -d); cp index.html "$d/"; [ -n "${1:-}" ] && echo "$1" > "$d/version.txt"; echo "$d"; }
run() { d=$1; shift; env STAMP_COMMIT="${C:-$SHA}" STAMP_DATE="${D:-$DATE}" "$@" bash scripts/stamp-version.sh "$d" >/dev/null 2>&1; }
mm() { d=$(mk); printf '%s' "$1" > "$d/.release-please-manifest.json"; echo "$d"; }
has() { grep -q -- "$2" "$1"; }

d=$(mk 1.2.3); ok run "$d" STAMP_TAG=v1.2.3
ok has "$d/index.html" '>v1.2.3</a>'
ok has "$d/version.json" '"version":"1.2.3","commit":"'$SHA'","date":"'$DATE'","release":true'
ok has "$d/index.html" '<title>GitHub PR Dashboard v1.2.3</title>'
d=$(mk 1.2.3); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
ok has "$d/index.html" '>v1.2.3+0123456</a>'
ok has "$d/index.html" '<title>GitHub PR Dashboard v1.2.3+0123456</title>'
ok has "$d/version.json" '"release":false'
d=$(mk); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
ok has "$d/index.html" '>dev+0123456</a>'
ok has "$d/index.html" '<title>GitHub PR Dashboard dev+0123456</title>'
ok has "$d/version.json" '"version":"0.0.0".*"release":false'
d=$(mk 1.2.3); ok run "$d" STAMP_TAG=v9.9
ok has "$d/version.json" '"release":false'
ok has index.html '>dev</a>'
ok has index.html '<title>GitHub PR Dashboard</title>'
ok test ! -e version.json
for v in '1.2' '1.2.3;rm' '$(id)' 'v1.2.3' '1.2.3|x'; do d=$(mk "$v"); ok no run "$d" STAMP_TAG= STAMP_NEAREST_TAG=; done
C=zzz; d=$(mk 1.2.3); run "$d" STAMP_TAG= STAMP_NEAREST_TAG=; ok has "$d/index.html" '<title>GitHub PR Dashboard</title>'; ok test ! -e "$d/version.json"; C=zzz; d=$(mk 1.2.3); ok no run "$d" STAMP_TAG= STAMP_NEAREST_TAG=; C=
D='2026-11-11'; d=$(mk 1.2.3); ok no run "$d" STAMP_TAG= STAMP_NEAREST_TAG=; D=
d=$(mktemp -d); echo '<html></html>' > "$d/index.html"; ok no run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
ok no bash scripts/stamp-version.sh
ok no bash scripts/stamp-version.sh /nonexistent
d=$(mk 1.2.3); bash scripts/stamp-version.sh "$d" >/dev/null 2>&1; ok test -f "$d/version.json"
# manifest source
d=$(mm '{".":"0.1.0"}'); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
ok has "$d/index.html" '>v0.1.0+0123456</a>'
ok has "$d/version.json" '"version":"0.1.0".*"release":false'
d=$(mm '{".":"0.1.0"}'); ok run "$d" STAMP_TAG=v0.1.0 STAMP_NEAREST_TAG=v0.1.0
ok has "$d/index.html" '>v0.1.0</a>'
ok has "$d/version.json" '"release":true'
d=$(mm '{".":"0.2.0"}'); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=v0.1.0
ok has "$d/index.html" '>v0.2.0+0123456</a>'
d=$(mm '{ ".": "0.3.0-rc.1" }'); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
ok has "$d/index.html" '>v0.3.0-rc.1+0123456</a>'
d=$(mm '{}'); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
ok has "$d/index.html" '>dev+0123456</a>'
d=$(mm '{}'); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=v0.4.1
ok has "$d/index.html" '>v0.4.1+0123456</a>'
# version.txt wins over the manifest
d=$(mm '{".":"0.1.0"}'); echo 5.6.7 > "$d/version.txt"; ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
ok has "$d/index.html" '>v5.6.7+0123456</a>'
# tag only
d=$(mk); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=v1.4.2
ok has "$d/version.json" '"version":"1.4.2"'
# hostile or malformed manifest / tag: ignored, never reaches sed or the shell
for m in '{".":"$(id)"}' '{".":"1.2.3;rm -rf /"}' '{".":"0.1"}' 'not json' '{".":"0.1.0|&"}'; do
  d=$(mm "$m"); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
  ok has "$d/index.html" '>dev+0123456</a>'
  ok no grep -q 'id)\|rm -rf' "$d/index.html" "$d/version.json"
  ok has "$d/index.html" '<title>GitHub PR Dashboard dev+0123456</title>'
done
d=$(mk); ok run "$d" STAMP_TAG= STAMP_NEAREST_TAG='v1.2.3;id'
ok has "$d/index.html" '>dev+0123456</a>'
# a copy without the title placeholder fails
d=$(mk 1.2.3); sed -i 's|<title>GitHub PR Dashboard</title>|<title>x</title>|' "$d/index.html"; ok no run "$d" STAMP_TAG= STAMP_NEAREST_TAG=
# real git: nearest reachable tag, in a scratch repo
r=$(mktemp -d); git -C "$r" init -q; mkdir "$r/scripts"; cp scripts/stamp-version.sh "$r/scripts/"; cp index.html "$r/"
git -C "$r" -c user.name=t -c user.email=t@t add -A; git -C "$r" -c user.name=t -c user.email=t@t commit -qm x; git -C "$r" tag v0.7.0
echo y >> "$r/index.html"; git -C "$r" -c user.name=t -c user.email=t@t commit -qam y
d=$(mktemp -d); cp index.html "$d/"; ok bash "$r/scripts/stamp-version.sh" "$d" >/dev/null
ok has "$d/index.html" '>v0.7.0+'
git -C "$r" tag v0.8.0; d=$(mktemp -d); cp index.html "$d/"; bash "$r/scripts/stamp-version.sh" "$d" >/dev/null
ok has "$d/index.html" '>v0.8.0</a>'
ok has "$d/version.json" '"release":true'
[ $fail = 0 ] && echo "stamp-version checks passed ($n)"
exit $fail
