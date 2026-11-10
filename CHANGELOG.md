# Changelog

All notable changes to this project, grouped by pull request. Format based on [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Fixed
- GitHub secondary rate limits (403/429 with `Retry-After`, or a "secondary rate limit" message) are recognised. One pause gate in the request layer stops all requests (auto refresh, status and wait-time lookups, bulk approve, manual Refresh) until the resume time, shown as "GitHub is asking us to slow down; automatic updates resume at HH:MM". `Retry-After` may be seconds or an HTTP date and is capped at 5 minutes; without it the wait escalates 60s, 120s, 240s, 300s and resets after a successful request. Blocked requests never extend the pause
- Fewer requests: PR statuses are cached per `updated_at` (CI that is still pending is refetched), so a refresh with nothing changed no longer refetches every PR (70-PR dashboard: 314 requests down to 10); background lookups run 2 at a time with a short gap, and write requests are at least 1s apart (a write waiting for its slot is dropped if a pause begins meanwhile); cached statuses also expire after 10 minutes because CI re-runs and base-branch changes do not move `updated_at`; with automatic refresh on, one refresh runs when the pause ends so interrupted statuses and wait times are completed

### Added
- CI workflow (`.github/workflows/tests.yml`) running the mocked end-to-end checks and the `create-pat.sh` checks on every pull request and on push to `main`
- The tests also run nightly (03:17 UTC, default branch) and on demand; a failed nightly run opens a `Nightly tests failed` issue, or comments on the open one. GitHub disables schedules after 60 days of repository inactivity
- "Waiting on me" tab: review-requested and assigned items open longer than 3/7/14/30 days (default 7), oldest first, with "waiting N days" on each row; shortcut `6`
- "Waiting on me" measures from when the review was requested or the item assigned to you (issue events; team requests handled; re-request resets the clock; withdrawn requests are excluded), labelled `since requested` / `since assigned`, falling back to `since opened`; lazy, cached, at most 2 concurrent lookups
- "Waiting on me" rows show the exact date the age is measured from (local time and zone) via a keyboard-focusable label with tooltip, overlay and screen-reader description

## 2026-11-05

### Added
- `scripts/create-pat.sh` opens GitHub's token page pre-filled with the permissions the dashboard needs, and can check the pasted token ([#17](https://github.com/Jubblin/prs/pull/17))
- "Check token" button (sign-in screen and header) that reports which permissions are ok, missing or cannot be verified, using read-only requests only ([#17](https://github.com/Jubblin/prs/pull/17))
- An automatic token check after sign-in and on load, at most once per browser session per token, skipped during bulk approve and while rate-limited ([#17](https://github.com/Jubblin/prs/pull/17))

### Security
- `create-pat.sh` keeps the token off command lines (it is passed to curl via a private temp file) and encodes non-ASCII token names correctly ([#17](https://github.com/Jubblin/prs/pull/17))

## 2026-10-30

### Added
- Full README, testing docs, screenshots and mocked-API tests ([#14](https://github.com/Jubblin/prs/pull/14))

### Fixed
- Literal "null" text no longer appears in the detail panel; null/false children are skipped in direct DOM appends and null labels/conclusions are handled ([#13](https://github.com/Jubblin/prs/pull/13))

## 2026-10-27

### Added
- Bulk approve for selected PRs ([#11](https://github.com/Jubblin/prs/pull/11))
- Keyboard shortcuts ([#10](https://github.com/Jubblin/prs/pull/10))

### Changed
- Repo filter is grouped by user/organization ([#12](https://github.com/Jubblin/prs/pull/12))

## 2026-10-26

### Changed
- Header, tabs and filters are sticky ([#8](https://github.com/Jubblin/prs/pull/8))
- Updated GitHub Actions to latest major versions ([#7](https://github.com/Jubblin/prs/pull/7))

### Fixed
- Scroll shift on manual Refresh ([#9](https://github.com/Jubblin/prs/pull/9))
- CI status display, Approve errors, and markdown rendering ([#4](https://github.com/Jubblin/prs/pull/4))

## 2026-10-25

### Added
- Auto-refresh for the dashboard ([#3](https://github.com/Jubblin/prs/pull/3))
- Renovate configuration ([#2](https://github.com/Jubblin/prs/pull/2))
- Initial static GitHub PR and issue dashboard, with GitHub Pages deployment, and persisted repo filter and active tab ([#1](https://github.com/Jubblin/prs/pull/1))

Note: #5 is an issue (the Renovate Dependency Dashboard), not a pull request. #6 was an auto-closed Renovate pin-dependencies PR that was never merged. Neither is listed.
