# GitHub PR Dashboard

A static, no-build dashboard (plain HTML/CSS/ES modules) for your open pull requests and issues on GitHub: PRs you authored, PRs awaiting your review, PRs assigned to or mentioning you, and issues assigned to / created by you. Open a row for body, comments, changed files and checks, and approve, request changes, comment, close/reopen or merge.

## Auto-refresh

The lists refresh automatically every 5 minutes; change the interval (Off, 2, 5, 10 min) with the **Auto** selector in the header. The choice is saved in `localStorage`, and the **Last updated HH:MM** label sits next to the **Refresh** button. Auto-refresh pauses while the tab is hidden (and refreshes on return if the data is stale), and is skipped while signed out, while a rate limit is active, or while a comment/approve/merge/close action is in flight. Tab, repo filter, selection and detail scroll are preserved.

Approve and Request changes are disabled (with an explanation) on your own PRs and on closed/merged PRs, since GitHub rejects those with a 422; drafts show a note. Any API error now includes GitHub's detailed reasons.

## Bulk approve

On the PR tabs each row has a checkbox. Once at least one PR is ticked, a toolbar appears under the filters showing the count with **Select all visible**, **Clear** and **Approve selected**. Selection survives refreshes (keyed by PR id; PRs that disappear or stop being approvable are dropped), is cleared when you switch tab or sign out, and ticking a box does not open the detail panel.

Your own PRs, closed/merged PRs and drafts cannot be selected; the disabled checkbox's tooltip (and the row) says why.

**Approve selected** opens a confirmation dialog listing every `repo#number` and title, with an optional comment shared by all approvals. Focus starts on Cancel and nothing is sent until you click **Confirm**; the dialog traps focus and `Esc` cancels (not while running). PRs are approved one at a time (`POST /pulls/{n}/reviews`, `event=APPROVE`) with per-PR progress. A failure (e.g. a 422 or 403, shown with GitHub's own reason) does not stop the rest; a 401 or a rate limit stops the batch and says so, leaving the remaining PRs "not attempted". The summary reads "N approved, M failed" and **Retry failed** re-runs only the failures. Auto-refresh is held off during the batch and statuses are refreshed once at the end. There is deliberately no keyboard shortcut for bulk approve.

## Keyboard shortcuts

Press `?` in the app for the same list. Shortcuts are ignored while typing in a field, when Ctrl/Alt/Meta is held, and (except `Esc` / `?`) while the help overlay is open. There is deliberately no approve/merge shortcut.

| Key | Action |
| --- | --- |
| `1`–`5` | Switch tab |
| `j` / `↓`, `k` / `↑` | Move the selected row down / up |
| `Enter` or `o` | Open the selected item's detail panel |
| `g` | Open the selected item on GitHub (new tab) |
| `r` | Refresh (ignored while a refresh/action is in flight or rate-limited) |
| `/` | Focus the text filter |
| `Esc` | Close the detail panel, or leave the filter box |
| `?` | Show / hide the help overlay |

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works (e.g. GitHub Pages); there is nothing to build.

## Token setup

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. Choose the repositories you want to see/act on (search results only include repos the token can access, plus public ones).
3. Repository permissions: **Pull requests: Read and write**, **Issues: Read and write**, **Metadata: Read**, **Checks: Read**, **Commit statuses: Read**, **Contents: Read** (**Contents: Write** is needed only to merge). Without Checks/Commit statuses the CI column shows "no access" and a banner names the missing permission; "none" means no CI is configured.
4. Paste the token on the sign-in screen.

## Security notes

- The token is kept in `localStorage` only and sent only to `https://api.github.com`. **Sign out** removes it.
- A Content-Security-Policy restricts network access to api.github.com and disallows inline scripts.
- All API-provided text is inserted via `textContent`; no `innerHTML`.
- Anyone with access to your browser profile or an XSS on the host origin can read the token; use a short-lived, minimally scoped token and host on an origin you control.
- Rate limits and API errors are shown in the red banner at the top.

PR/issue bodies and comments are rendered as Markdown by a small built-in renderer (`renderMarkdown` in `app.js`): headings, emphasis, strikethrough, inline/fenced code, blockquotes, lists, task-list checkboxes (read-only), tables, rules, links and autolinks (http/https/mailto only). Images load inline only from github.com, `*.githubusercontent.com` and github.githubassets.com over https (checked with `new URL()`, no userinfo/lookalike hosts; also enforced by the CSP `img-src`); any other host, or an image that fails to load, becomes a link with the alt text, raw HTML is shown as text and `<!-- comments -->` are hidden. Output is built with DOM nodes only, never `innerHTML`.
