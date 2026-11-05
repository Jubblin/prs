#!/usr/bin/env bash
# Network-free checks for scripts/create-pat.sh (--print only). Usage: bash tests/create-pat.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$here/scripts/create-pat.sh"
fails=0
ok() { echo "  ok    $1"; }
bad() { echo "  FAIL  $1"; fails=$((fails + 1)); }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing '$3' in $2)" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1 (found '$3')" ;; *) ok "$1" ;; esac; }

base="https://github.com/settings/personal-access-tokens/new?"
u="$(bash "$script" --print)"
has "default URL" "$u" "$base"; has "default name" "$u" "name=PR%20dashboard"
has "default expiry" "$u" "expires_in=30"; has "contents write" "$u" "contents=write"

u="$(bash "$script" --print --no-merge)"
has "--no-merge" "$u" "contents=read"; hasnt "--no-merge has no write" "$u" "contents=write"

u="$(LC_ALL=en_US.UTF-8 bash "$script" --print --name 'Zoë 日本')"
has "UTF-8 name encoded per byte" "$u" "name=Zo%C3%AB%20%E6%97%A5%E6%9C%AC&"
u="$(LC_ALL=C bash "$script" --print --name 'Zoë 日本')"
has "same under the C locale" "$u" "name=Zo%C3%AB%20%E6%97%A5%E6%9C%AC&"
u="$(bash "$script" --print --name 'a&b=c#d')"
has "reserved characters" "$u" "name=a%26b%3Dc%23d&"
u="$(bash "$script" --print --expires 7)"; has "--expires" "$u" "expires_in=7"

has "--help" "$(bash "$script" --help)" "Usage:"
if bash "$script" --expires abc >/dev/null 2>&1; then bad "bad --expires rejected"; else ok "bad --expires rejected"; fi
if bash "$script" --bogus >/dev/null 2>&1; then bad "unknown option rejected"; else ok "unknown option rejected"; fi

# The token must not reach any command line: fake curl records its argv; the token only comes via -K config.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/curl" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
cfg=""; while [ $# -gt 0 ]; do [ "$1" = "-K" ] && cfg="$2"; shift; done
[ -n "$cfg" ] && [ "$(stat -c %a "$cfg")" = "600" ] && grep -q 'Bearer s3cr3t' "$cfg" && echo cfg-ok >>"$FAKE_LOG"
printf '200'
FAKE
printf "#!/bin/sh\nexit 0\n" >"$tmp/xdg-open"; cp "$tmp/xdg-open" "$tmp/open"
chmod +x "$tmp/curl" "$tmp/xdg-open" "$tmp/open"
FAKE_LOG="$tmp/log" PATH="$tmp:$PATH" GH_TOKEN=s3cr3t BROWSER= bash "$script" </dev/null >"$tmp/out" 2>&1 || true
log="$(cat "$tmp/log")"
hasnt "token not in curl argv" "$(grep -v cfg-ok <<<"$log")" "s3cr3t"
has "curl got a mode-600 config with the token" "$log" "cfg-ok"
hasnt "token not printed" "$(cat "$tmp/out")" "s3cr3t"

[ "$fails" -eq 0 ] && echo "create-pat.sh: all passed" || { echo "create-pat.sh: $fails failed"; exit 1; }
