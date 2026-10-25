# GitHub PR Dashboard

A static, no-build dashboard (plain HTML/CSS/ES modules) for your open pull requests and issues on GitHub: PRs you authored, PRs awaiting your review, PRs assigned to or mentioning you, and issues assigned to / created by you. Open a row for body, comments, changed files and checks, and approve, request changes, comment, close/reopen or merge.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works (e.g. GitHub Pages); there is nothing to build.

## Token setup

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
2. Choose the repositories you want to see/act on (search results only include repos the token can access, plus public ones).
3. Repository permissions: **Pull requests: Read and write**, **Issues: Read and write**, **Metadata: Read**. (Add **Checks: Read** and **Commit statuses: Read** to show CI status on private repos.)
4. Paste the token on the sign-in screen.

## Security notes

- The token is kept in `localStorage` only and sent only to `https://api.github.com`. **Sign out** removes it.
- A Content-Security-Policy restricts network access to api.github.com and disallows inline scripts.
- All API-provided text is inserted via `textContent`; no `innerHTML`.
- Anyone with access to your browser profile or an XSS on the host origin can read the token; use a short-lived, minimally scoped token and host on an origin you control.
- Rate limits and API errors are shown in the red banner at the top.
