#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
fail=0
check() { # expected(0|1) title
  bash ./pr-title.sh "$2" 2>/dev/null; rc=$?
  if [ "$rc" != "$1" ]; then echo "FAIL (expected $1, got $rc): $2"; fail=1; fi
}
for t in "feat: add tab" "fix(list): keep focus" "feat!: drop old storage" "chore(deps): update github-actions" \
  "ci: add release-please" "docs: update README" "revert: undo thing" "perf(api)!: cache statuses" \
  'Revert "fix(list): keep focus"' 'Revert "feat!: drop old storage"'; do check 0 "$t"; done
for t in "Add tab" "feat add tab" "feat:no space" "Feat: x" "feature: x" "fix(): x" "fix(Scope): x" "feat: " "" "chore(deps) update" 'Revert "Add tab"' 'Revert fix: x' 'Revert ""'; do check 1 "$t"; done
[ $fail = 0 ] && echo "pr-title checks passed"
exit $fail
