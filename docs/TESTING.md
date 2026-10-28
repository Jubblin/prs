# Testing

The app is a static, dependency-free site with no build step. Testing has three layers:

1. **Mocked-API end-to-end checks** (automated, `node tests/run.mjs`): a headless Chromium drives the real `index.html`/`app.js` while a small in-memory fake of api.github.com answers every request. Fast, deterministic, can inject any HTTP error.
2. **Manual checklist** (below): covers every feature and error case, including things the mock cannot prove.
3. **Real-GitHub smoke test** (below): a short run against a throwaway repo and token.

Nothing in `tests/` is loaded by the app; Playwright is a dev-only tool that is never added to the app or committed.

## Running the mocked-API tests

Needs Node 20+ (tested on 22). Install Playwright **inside `tests/`** without touching the app (there is no `package.json`, and `node_modules/` is git-ignored):

```sh
cd tests
npm install --no-save --no-package-lock playwright
npx playwright install chromium
cd ..
```

Then, from the repository root, one command:

```sh
node tests/run.mjs            # all checks; exit code 1 if any fail
node tests/run.mjs bulk       # only checks whose name contains "bulk"
node tests/shots.mjs          # regenerate docs/img/*.png from the mock
```

If Playwright lives elsewhere, point Node at it: `NODE_PATH=/path/to/node_modules node tests/run.mjs`.

How it works: `tests/lib.mjs` serves the repo root on a random localhost port; `page.route()` intercepts `https://api.github.com/**` and hands it to `tests/mock-github.mjs`, which holds fixture PRs/issues and can be told to fail any request (`mock.fail('POST', '/reviews', 422, body, headers, times)`). Image hosts are stubbed with a 1×1 PNG and `evil.example` is aborted; every outgoing host is recorded. Each check runs in a fresh browser context and also fails on any uncaught page error.

## What the automated checks cover (all against the mock)

Sign-in/401/sign-out; persistence of tab, repo and auto interval (and fallback for bad saved values); five tabs, counts, merged assigned/mentioned query; owner-grouped repo filter, `<owner> — all repos`, case-insensitive restore; text filter; CI states (success, failure, pending, none, `no access` on 403, `error` on 500, per-PR failure) and review states, permission banner; `null` mergeable retry; rate-limit banner; detail panel content; XSS payloads in body, comments and titles; link and image allow-list cases; failing-image fallback; own/closed/draft gating; comment/approve/request-changes/merge/close/reopen including 422/403/404/405/429/500 responses and merge confirm; bulk approve (selectability reasons, selection pruning, dialog focus and Esc, shared comment, partial failure, retry, 429 stop, 401 stop); manual refresh keeping scroll, refresh failure keeping data, sticky header; auto-refresh timer (fake clock) and Off; keyboard shortcuts and their guards; CSP policy and enforcement (inline script, foreign fetch and foreign image blocked); hosts contacted; no overflow at phone width.

## Verified vs. NOT verified

**Verified against mocked APIs** (50 checks, all passing at the time of writing): everything listed above, in Chromium headless only.

**NOT verified on real GitHub / real browsers:**
- The mock is written from our reading of the API, not generated from it. Real response shapes, pagination (`per_page=100` only, no paging), search ranking, and field availability (e.g. fine-grained-token 403 vs 404 behaviour, `mergeable_state` values, `check-runs` for forks) may differ.
- Real rate-limit headers and timing; the 5-minute auto-refresh in real time (a fake clock was used).
- Actual merge, approve, close and comment side effects and branch protection rules (required reviews, merge queues, "Contents: Write" requirement).
- Image loading from real `github.com`/`githubusercontent.com` URLs (private-repo attachment URLs, redirects, signed URLs).
- Real CSP behaviour on a deployed GitHub Pages origin (headers, `frame-ancestors`, which a `<meta>` CSP cannot set).
- Firefox, Safari, mobile browsers and real touch input; screen readers and keyboard focus order beyond what is asserted.
- Large accounts (hundreds of PRs, search capped at 50 per query) and GitHub Enterprise (the API host is hard-coded).

## Manual checklist

Use the smoke-test setup below. Tick each item; the automated check covering it is noted where one exists, but repeat the item by hand at least once on real GitHub before a release.

### Sign-in, sign-out, persistence
- [ ] Bad token → red banner with `401`, stays on sign-in, nothing in `localStorage`.
- [ ] Valid token → username shown, lists load, field cleared.
- [ ] Reload → still signed in; tab, repo filter and Auto interval restored; text filter empty.
- [ ] Corrupt `localStorage` values (`gh_dashboard_tab=bogus`, `gh_dashboard_autorefresh=99`) → defaults (My PRs, 5 min).
- [ ] **Sign out** → token removed, list/detail/bulk bar gone, login shown.
- [ ] Revoke the token on GitHub, then Refresh → "Token rejected (401)" and you are signed out.

### Tabs, repo filter, text filter
- [ ] Each tab shows the right items and count; `1`–`5` switch tabs.
- [ ] Assigned/mentioned tab shows each PR once even if both queries match.
- [ ] Repo dropdown groups by owner; `<owner> — all repos` shows every repo of that owner; a single repo narrows further; All repos clears.
- [ ] Repo choice persists across reload; if that repo is not in the current tab the dropdown shows All repos (and the list is unfiltered).
- [ ] Text filter matches title, `owner/repo`, and number; "Nothing here." when empty.

### CI and review status
- [ ] CI `success`, `failure`, `pending` (running checks), `none` (repo with no CI), each on a real PR.
- [ ] Review `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`.
- [ ] Token without Checks/Commit statuses → `no access` plus the permission banner; token without Pull requests read → `Review: unknown`.
- [ ] Forced 500 (DevTools → block `check-runs`) → `CI: error`, hover shows reason.
- [ ] Brand-new PR: `mergeable: computing…` resolves to a real state in the detail panel (null `mergeable` retry).

### Detail panel and Markdown
- [ ] Click, `Enter`, `o` open it; `Esc`/Close dismiss it. Body, comments, check runs, changed files (`+n −n`) render.
- [ ] Headings, bold/italic/strike, code and fenced code, quotes, nested lists, task lists (read-only), tables, rules render; raw HTML shows as text; `<!-- -->` hidden.
- [ ] Scroll position of list and panel survive a refresh.

### XSS payloads
Put each of these in a PR body, a comment and a title on a test repo; none may execute, create elements, or navigate. DevTools must show no new `script`, no `on*` attributes, and no `javascript:` hrefs.
- `<script>alert(1)</script>`
- `<img src=x onerror=alert(1)>`
- `<svg onload=alert(1)>`, `<iframe src="javascript:alert(1)">`
- `[click](javascript:alert(1))`, `[click](  JaVaScRiPt:alert(1))`, `[x](data:text/html,<script>alert(1)</script>)`
- `![x](javascript:alert(1))`, `![x](data:image/svg+xml,<svg onload=alert(1)>)`
- `<https://example.com" onmouseover="alert(1)>`
- `` `<script>` `` and a fenced block containing `</code></pre><script>alert(1)</script>`
- `**<b onclick=alert(1)>x</b>**`, a title of `"><img src=x onerror=alert(1)>`

### Image host allow-list
Each of these in a body; check DevTools → Network.
- [ ] `https://github.com/.../x.png`, `https://user-images.githubusercontent.com/...`, `https://github.githubassets.com/...` → inline image.
- [ ] `https://evil.example/x.png` → `🖼 alt` link, **no request** made.
- [ ] `https://github.com.evil.example/x.png`, `https://github.com@evil.example/x.png`, `https://evilgithub.com/x.png`, `https://evil.com/?u=githubusercontent.com` → links, no request.
- [ ] `http://github.com/x.png` (not https), `https://github.com:8443/x.png` (port) → links.
- [ ] Allowed host but 404 → image replaced by a `🖼` link.

### CSP
- [ ] `index.html` meta policy: `connect-src https://api.github.com`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, no `unsafe-*`.
- [ ] In the console, `fetch('https://example.com')`, injecting an inline `<script>`, and `new Image().src='https://example.com/x.png'` are all blocked with CSP errors.
- [ ] Normal use produces no CSP violations; Network shows only `api.github.com` and the allowed image hosts.

### Gating and actions (throwaway repo)
- [ ] **Own PR**: Approve/Request changes disabled, note "GitHub does not allow approving your own PR"; Comment and Close work.
- [ ] **Closed/merged PR**: review buttons disabled with note; Reopen offered (closed, not merged).
- [ ] **Draft PR**: note shown; Approve is attempted and GitHub's response (accepted or 422) is shown.
- [ ] Comment with empty text → "Enter a comment first."; with text it posts and appears.
- [ ] Approve with and without comment; Request changes requires a comment.
- [ ] Merge: confirm dialog → Cancel does nothing; OK merges (needs Contents: Write); branch-protection failure shows GitHub's reason (e.g. 405).
- [ ] Close then Reopen an issue and a PR; label and state flip.
- [ ] Buttons re-enable after any failure.

### HTTP error handling
Reproduce with DevTools request blocking/overrides, a read-only token, or a token for a different account.
- [ ] **401** → signed out with message (also during bulk approve).
- [ ] **403** (read-only token) on approve/comment → `GitHub API error 403: …` banner with GitHub's text.
- [ ] **404** (repo not accessible) → `GitHub API error 404: Not Found`; detail load failure closes the panel with the banner.
- [ ] **422** (approve own PR, request changes without body) → message plus detailed reasons after "—".
- [ ] **429 / 403 with `x-ratelimit-remaining: 0`** → "Rate limit exceeded. Resets at HH:MM."; auto-refresh and bulk approve hold off until then.
- [ ] **500/502** → `GitHub API error 500: …`; lists keep their old data on a failed refresh.

### Refresh and scroll
- [ ] Refresh button updates "Last updated HH:MM"; scrolled list does not jump; open detail panel keeps scroll.
- [ ] Auto 2/5/10/Off: refreshes at the interval; Off never refreshes; hidden tab pauses and refreshes on return when stale.
- [ ] Auto-refresh does not fire while a comment/approve/merge/bulk run is in flight.
- [ ] Header, tabs, filters and bulk bar stay visible while scrolling.

### Keyboard shortcuts
- [ ] `1`–`5`, `j`/`↓`, `k`/`↑`, `Enter`/`o`, `g` (new tab), `r`, `/`, `Esc`, `?` all behave as listed in the README.
- [ ] Nothing fires while typing in the filter/comment box, with Ctrl/Alt/Meta, or while the bulk dialog is open; only `Esc`/`?` work while help is open.
- [ ] There is no shortcut for approve, merge or bulk approve.

### Bulk approve
- [ ] Own, closed and draft PRs have disabled checkboxes with the reason.
- [ ] Toolbar count, Select all visible, Clear; ticking does not open the detail panel.
- [ ] Changing the filter drops hidden PRs and they are not re-selected; tab switch and sign-out clear the selection.
- [ ] Dialog lists every PR, focus starts on Cancel, Tab stays inside, `Esc` cancels, clicking outside cancels; nothing sent until Confirm.
- [ ] Approvals run one at a time with progress; shared comment is on every review.
- [ ] One failure (e.g. a PR you authored slipped in, or a 422) does not stop the rest; summary "N approved, M failed"; Retry failed re-runs only those.
- [ ] Rate limit or 401 mid-batch stops it; remainder "not attempted".

### Layout
- [ ] Light and dark OS themes both readable; phone width (≈390 px) has no horizontal scroll and the list stays usable.

## Real-GitHub smoke test (about 10 minutes)

Use a **throwaway account or repo**, never a repo you care about.

1. Create a private repo `prs-smoke` and a **fine-grained token** limited to that repo with Pull requests R/W, Issues R/W, Metadata R, Checks R, Commit statuses R, Contents R/W. Set a 1-day expiry. (A second account or collaborator is needed to open PRs that you can approve; otherwise you can only test own-PR gating.)
2. In the repo create: a PR from your account (own PR), a PR from the second account requesting your review (add a workflow that fails or passes if you want CI), a draft PR, an issue assigned to you, and a PR containing an `evil.example` image and a `<script>` in its body.
3. `python3 -m http.server 8000`, open <http://localhost:8000>, sign in.
4. Check: all five tabs list the right items; CI/Review labels match GitHub; the evil image is a link and no script runs; own-PR approve is disabled; approve the review-requested PR and see it on GitHub; comment on it; bulk approve two PRs; close and reopen the issue; merge the PR (confirm).
5. DevTools → Network contains only `api.github.com` and GitHub image hosts; Console has no errors.
6. Sign out, then **delete the token** (and the repo if finished).
