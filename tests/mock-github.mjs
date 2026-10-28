// Minimal in-memory fake of the parts of api.github.com the dashboard uses (dev/test only).
export const ME = 'me';
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();

const BODY = [
  '## Summary', 'Fixes **bold** and _italic_ with `code`.', '', '- [x] done task', '- [ ] open task', '',
  '| a | b |', '| - | - |', '| 1 | 2 |', '',
  '![ok](https://github.com/acme/web/assets/1/ok.png)',
  '![evil](https://evil.example/track.png)',
  '![lookalike](https://github.com.evil.example/x.png)',
  '![userinfo](https://github.com@evil.example/x.png)',
  '![cdn](https://user-images.githubusercontent.com/1/pic.png)',
  '![http](http://github.com/insecure.png)',
  '<!-- hidden comment -->', '<script>window.__xss=1</script>', '<img src=x onerror="window.__xss=2">',
  '[js](javascript:window.__xss=3)', '[ok link](https://example.com/page)', 'https://example.com/bare',
].join('\n');

function pr(o) {
  return { state: 'open', draft: false, body: 'Plain body', labels: [], user: { login: 'alice' }, updated_at: iso(30), created_at: iso(3000),
    mergeable: true, mergeable_state: 'clean', ci: 'success', reviews: [], files: [{ filename: 'src/a.js', additions: 3, deletions: 1 }], comments: [], ...o,
    pull_request: {}, html_url: `https://github.com/${o.repo}/pull/${o.number}`, repository_url: `https://api.github.com/repos/${o.repo}` };
}
function issue(o) {
  return { state: 'open', body: 'Issue body', labels: [{ name: 'bug' }], user: { login: ME }, updated_at: iso(60), created_at: iso(5000), comments: [], ...o,
    html_url: `https://github.com/${o.repo}/issues/${o.number}`, repository_url: `https://api.github.com/repos/${o.repo}` };
}

export function createMock() {
  let nextId = 1;
  const items = [
    pr({ repo: 'me/own-repo', number: 1, title: 'My own PR', user: { login: ME }, reviews: [] }),
    pr({ repo: 'acme/web', number: 10, title: 'Add dark mode', body: BODY, comments: [{ user: { login: 'bob' }, created_at: iso(20), body: 'Looks good <b>x</b> **nice**' }], reviews: [{ user: { login: 'bob' }, state: 'APPROVED' }] }),
    pr({ repo: 'acme/web', number: 11, title: 'Draft: refactor router', draft: true, ci: 'pending' }),
    pr({ repo: 'acme/api', number: 12, title: 'Fix <img src=x onerror=alert(1)> crash', ci: 'failure', reviews: [{ user: { login: 'carol' }, state: 'CHANGES_REQUESTED' }] }),
    pr({ repo: 'other/tools', number: 13, title: 'Bump deps', ci: 'none' }),
    pr({ repo: 'acme/api', number: 14, title: 'Null mergeable first', nullMergeable: 1 }),
    pr({ repo: 'acme/api', number: 15, title: 'Closed PR', state: 'closed' }),
    issue({ repo: 'acme/web', number: 20, title: 'Assigned issue', user: { login: 'dave' } }),
    ...Array.from({ length: 30 }, (_, k) => issue({ repo: 'me/own-repo', number: 100 + k, title: `Filler issue ${k}` })),
  ].map((x) => ({ ...x, id: nextId++ }));
  const byKey = (repo, n) => items.find((i) => i.repo === repo && i.number === Number(n));
  const tabs = {
    'is:pr is:open author:@me': (i) => i.pull_request && i.user.login === ME && i.state === 'open',
    'is:pr is:open review-requested:@me': (i) => i.pull_request && i.user.login !== ME && i.state === 'open' && i.number !== 12 || i.number === 15,
    'is:pr is:open assignee:@me': (i) => i.number === 10,
    'is:pr is:open mentions:@me': (i) => i.number === 12,
    'is:issue is:open assignee:@me': (i) => i.number === 20,
    'is:issue is:open author:@me': (i) => !i.pull_request && i.user.login === ME,
  };
  const m = {
    items, calls: [], faults: [], rateLimit: false,
    fail(method, re, status, body = { message: 'Injected' }, headers = {}, times = Infinity) { m.faults.push({ method, re: new RegExp(re), status, body, headers, times }); },
    reset() { m.faults = []; m.calls = []; },
    called(method, re) { return m.calls.filter((c) => c.method === method && new RegExp(re).test(c.path)); },
    async handle(route) {
      const req = route.request(), url = new URL(req.url()), method = req.method(), path = url.pathname + url.search;
      let body = null; try { body = req.postDataJSON(); } catch { /* none */ }
      m.calls.push({ method, path, body });
      const send = (status, json, headers = {}) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': '*', ...headers }, body: JSON.stringify(json) });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      const f = m.faults.find((x) => x.method === method && x.re.test(path) && x.times > 0);
      if (f) { f.times--; return send(f.status, f.body, f.headers); }
      let r;
      if (path === '/user') return send(200, { login: ME });
      if (url.pathname === '/search/issues') {
        const q = url.searchParams.get('q'), p = tabs[q];
        return send(200, { items: p ? items.filter(p).map((i) => ({ ...i })) : [] });
      }
      if ((r = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/(reviews|files)$/.exec(url.pathname))) {
        const i = byKey(r[1], r[2]); if (!i) return send(404, { message: 'Not Found' });
        if (r[3] === 'files') return send(200, i.files);
        if (method === 'POST') { i.reviews.push({ user: { login: ME }, state: body.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED' }); return send(200, { id: 1 }); }
        return send(200, i.reviews);
      }
      if ((r = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(url.pathname))) { const i = byKey(r[1], r[2]); i.state = 'closed'; return send(200, { merged: true }); }
      if ((r = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname))) {
        const i = byKey(r[1], r[2]); if (!i) return send(404, { message: 'Not Found' });
        let mergeable = i.mergeable;
        if (i.nullMergeable > 0) { i.nullMergeable--; mergeable = null; }
        return send(200, { state: i.state, draft: i.draft, mergeable, mergeable_state: mergeable == null ? 'unknown' : i.mergeable_state, head: { sha: 'sha' + i.number } });
      }
      if ((r = /^\/repos\/([^/]+\/[^/]+)\/commits\/sha(\d+)\/(check-runs|status)$/.exec(url.pathname))) {
        const i = items.find((x) => x.pull_request && x.number === Number(r[2]) && r[1] === x.repo); if (!i) return send(404, { message: 'Not Found' });
        if (r[3] === 'status') return send(200, { state: 'success', total_count: 0 });
        const runs = { success: [{ name: 'build', status: 'completed', conclusion: 'success' }], failure: [{ name: 'build', status: 'completed', conclusion: 'failure' }], pending: [{ name: 'build', status: 'in_progress' }], none: [] }[i.ci];
        return send(200, { check_runs: runs });
      }
      if ((r = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
        const i = byKey(r[1], r[2]); if (!i) return send(404, { message: 'Not Found' });
        if (method === 'POST') { i.comments.push({ user: { login: ME }, created_at: new Date().toISOString(), body: body.body }); return send(201, {}); }
        return send(200, i.comments);
      }
      if ((r = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.pathname))) {
        const i = byKey(r[1], r[2]); if (!i) return send(404, { message: 'Not Found' });
        if (method === 'PATCH') { i.state = body.state; if (i.state === 'open') i.updated_at = iso(0); }
        return send(200, { ...i });
      }
      return send(404, { message: 'Unmocked ' + path });
    },
  };
  return m;
}
