#!/usr/bin/env bash
# Succeeds when the title ($1) is a Conventional Commit title; prints why not otherwise.
title="${1-}"
re='^(feat|fix|perf|docs|test|ci|chore|refactor|style|build|revert)(\([a-z0-9._/-]+\))?!?: [^ ].*$'
revert_re='^Revert "(feat|fix|perf|docs|test|ci|chore|refactor|style|build|revert)(\([a-z0-9._/-]+\))?!?: [^ ].*"$'
if [[ "$title" =~ $re || "$title" =~ $revert_re ]]; then exit 0; fi
echo "PR title must look like 'type(scope)!: description' with type one of feat, fix, perf, docs, test, ci, chore, refactor, style, build, revert. (GitHub revert titles like Revert "fix: x" are also accepted). Got: $title" >&2
exit 1
