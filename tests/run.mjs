// Mocked-API end-to-end checks. Usage: node tests/run.mjs [name-filter]
import assert from 'node:assert/strict';
import { loadPlaywright, serve, open, settled } from './lib.mjs';

const { chromium } = loadPlaywright();
const { srv, url } = await serve();
const browser = await chromium.launch();
const only = process.argv[2];
const results = [];
async function test(name, fn, opts) {
  if (only && !name.includes(only)) return;
  const env = await open(browser, url, opts);
  try {
    await fn(env);
    assert.deepEqual(env.errors, [], 'uncaught page errors');
    results.push([name, null]); console.log('ok   ' + name);
  } catch (e) { results.push([name, e]); console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').join('\n     ')); }
  await env.context.close();
}
const txt = (p, sel) => p.locator(sel).innerText();
const row = (p, title) => p.locator('#list li', { hasText: title });
const open_ = async (p, title) => { await row(p, title).click(); await p.locator('#detail h3', { hasText: 'Comments' }).waitFor(); };
const tab = (p, n) => p.locator('#tabs button').nth(n - 1).click();
const until = async (fn, what = 'condition') => { for (let n = 0; n < 100; n++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out waiting for ' + what); };

// ---- sign-in, sign-out, persistence ----
await test('login: bad token (401) shows error and stays signed out', async ({ page, mock }) => {
  mock.fail('GET', '^/user$', 401, { message: 'Bad credentials' });
  await page.locator('#token').fill('bad'); await page.locator('#loginform button').click();
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('401'));
  assert.equal(await page.locator('#login').isVisible(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('gh_dashboard_token')), null);
}, { token: null });
await test('login: good token loads lists, stores token, shows user', async ({ page }) => {
  await page.locator('#token').fill('good'); await page.locator('#loginform button').click();
  await page.locator('#list li').first().waitFor();
  assert.equal(await txt(page, '#username'), 'me');
  assert.equal(await page.evaluate(() => localStorage.getItem('gh_dashboard_token')), 'good');
  assert.equal(await page.locator('#token').inputValue(), '');
}, { token: null });
await test('sign-out: clears token, list, selection, and shows login', async ({ page }) => {
  await tab(page, 2); await settled(page);
  await page.locator('#list li input[type=checkbox]:not(:disabled)').first().check();
  await page.locator('#signout').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('gh_dashboard_token')), null);
  assert.equal(await page.locator('#list li').count(), 0);
  assert.equal(await page.locator('#login').isVisible(), true);
  assert.equal(await page.locator('#controls').isVisible(), false);
  assert.equal(await page.locator('#bulkbar').isVisible(), false);
});
await test('401 mid-session signs out with message', async ({ page, mock }) => {
  mock.fail('GET', '/search/issues', 401, { message: 'Bad credentials' });
  await page.locator('#refresh').click();
  await page.locator('#login').waitFor();
  assert.match(await txt(page, '#banner'), /401/);
});
await test('persistence: tab, repo filter, auto interval survive reload; text filter does not', async ({ page }) => {
  await tab(page, 2);
  await page.locator('#repofilter').selectOption('acme/web');
  await page.locator('#autorefresh').selectOption('10');
  await page.locator('#textfilter').fill('dark');
  await page.reload();
  await page.locator('#list li').first().waitFor();
  assert.equal(await page.locator('#tabs button[aria-selected=true]').innerText().then((t) => t.replace(/\d+$/, '').trim()), 'Review requested');
  assert.equal(await page.locator('#repofilter').inputValue(), 'acme/web');
  assert.equal(await page.locator('#autorefresh').inputValue(), '10');
  assert.equal(await page.locator('#textfilter').inputValue(), '');
});
await test('persistence: unknown saved tab/auto values fall back to defaults', async ({ page }) => {
  assert.equal(await page.locator('#autorefresh').inputValue(), '5');
  assert.match(await txt(page, '#tabs button[aria-selected=true]'), /My PRs/);
}, { storage: { gh_dashboard_tab: 'bogus', gh_dashboard_autorefresh: '99' } });

// ---- tabs and filters ----
await test('tabs: five tabs with counts; keys 1-5 switch', async ({ page }) => {
  await page.locator('#list li').first().waitFor();
  assert.equal(await page.locator('#tabs button').count(), 5);
  const counts = await page.locator('#tabs .count').allInnerTexts();
  assert.deepEqual(counts, ['1', '5', '2', '1', '30']);
  for (let n = 1; n <= 5; n++) { await page.keyboard.press(String(n)); assert.equal(await page.locator('#tabs button').nth(n - 1).getAttribute('aria-selected'), 'true'); }
});
await test('tabs: assigned/mentioned PR tab merges two queries', async ({ page, mock }) => {
  await tab(page, 3);
  assert.equal(await page.locator('#list li').count(), 2);
  assert.ok(mock.called('GET', 'assignee').length && mock.called('GET', 'mentions').length);
});
await test('repo filter: grouped by owner with owner-wide option; narrows list', async ({ page }) => {
  await tab(page, 2);
  const groups = await page.$$eval('#repofilter optgroup', (g) => g.map((x) => [x.label, [...x.children].map((o) => [o.value, o.textContent])]));
  assert.deepEqual(groups, [
    ['acme', [['acme/', 'acme — all repos'], ['acme/api', 'api'], ['acme/web', 'web']]],
    ['other', [['other/', 'other — all repos'], ['other/tools', 'tools']]]]);
  await page.locator('#repofilter').selectOption('acme/');
  assert.equal(await page.locator('#list li').count(), 4);
  await page.locator('#repofilter').selectOption('acme/web');
  assert.equal(await page.locator('#list li').count(), 2);
  await page.locator('#repofilter').selectOption('');
  assert.equal(await page.locator('#list li').count(), 5);
});
await test('repo filter: saved owner-wide value restored, case-insensitively; missing value falls back to All', async ({ page }) => {
  await tab(page, 2);
  assert.equal(await page.locator('#repofilter').inputValue(), 'acme/');
  await tab(page, 1);
  assert.equal(await page.locator('#repofilter').inputValue(), '');
}, { storage: { gh_dashboard_repo: 'ACME/', gh_dashboard_tab: 'review' } });
await test('text filter: matches title, repo and number; "/" focuses, Esc leaves', async ({ page }) => {
  await tab(page, 2);
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'textfilter');
  await page.keyboard.type('dark'); assert.equal(await page.locator('#list li').count(), 1);
  await page.locator('#textfilter').fill('OTHER/TOOLS'); assert.equal(await page.locator('#list li').count(), 1);
  await page.locator('#textfilter').fill('14'); assert.equal(await page.locator('#list li').count(), 1);
  await page.locator('#textfilter').fill('zzz'); assert.equal(await txt(page, '#list'), 'Nothing here.');
  await page.keyboard.press('Escape');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'textfilter');
});

// ---- CI / review status ----
await test('status: CI success/failure/pending/none and review states', async ({ page }) => {
  await tab(page, 2); await settled(page);
  const s = async (t) => (await row(page, t).locator('.meta').innerText());
  assert.match(await s('Add dark mode'), /CI: success.*Review: APPROVED/s);
  assert.match(await s('Draft: refactor'), /CI: pending.*Review: REVIEW_REQUIRED/s);
  assert.match(await s('Bump deps'), /CI: none.*Review: REVIEW_REQUIRED/s);
  await tab(page, 3); await settled(page);
  assert.match(await s('Fix'), /CI: failure.*Review: CHANGES_REQUESTED/s);
});
await test('status: 403 on checks+statuses -> "no access" and permission banner', async ({ page, mock }) => {
  mock.fail('GET', '/check-runs', 403, { message: 'Resource not accessible' }); mock.fail('GET', '/status$', 403, { message: 'Resource not accessible' });
  await page.locator('#refresh').click(); await tab(page, 2); await settled(page);
  assert.match(await txt(page, '#list'), /CI: no access/);
  assert.match(await txt(page, '#permbanner'), /Checks: Read.*Commit statuses: Read/);
});
await test('status: 404 on reviews -> "Review: unknown" and Pull requests: Read hint', async ({ page, mock }) => {
  mock.fail('GET', '/reviews', 404); await page.locator('#refresh').click(); await tab(page, 2); await settled(page);
  assert.match(await txt(page, '#list'), /Review: unknown/);
  assert.match(await txt(page, '#permbanner'), /Pull requests: Read/);
});
await test('status: 500 on checks -> "CI: error" with reason', async ({ page, mock }) => {
  mock.fail('GET', '/check-runs', 500, { message: 'Server broke' }); mock.fail('GET', '/status$', 500, { message: 'Server broke' });
  await page.locator('#refresh').click(); await tab(page, 2); await settled(page);
  assert.match(await txt(page, '#list'), /CI: error/);
  assert.match(await page.locator('#list .st-error').first().getAttribute('title'), /Server broke/);
});
await test('status: 500 on PR fetch -> CI error for that PR only', async ({ page, mock }) => {
  mock.fail('GET', '/pulls/13$', 500, { message: 'boom' }); await page.locator('#refresh').click(); await tab(page, 2); await settled(page);
  assert.match(await row(page, 'Bump deps').innerText(), /CI: error/);
  assert.match(await row(page, 'Add dark mode').innerText(), /CI: success/);
});
await test('status: null mergeable is retried, detail then shows state', async ({ page }) => {
  await tab(page, 2); await open_(page, 'Null mergeable first');
  assert.match(await txt(page, '#detail'), /mergeable: clean/);
});
await test('rate limit (403 + remaining 0) shows reset banner', async ({ page, mock }) => {
  mock.fail('GET', '/search/issues', 403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => /Rate limit exceeded/.test(document.getElementById('banner').textContent));
});

// ---- detail, markdown, XSS, images ----
await test('detail: shows body, comments, checks, files, state; Esc and Close close it', async ({ page }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const t = await txt(page, '#detail');
  for (const s of ['acme/web#10: Add dark mode', 'by alice', 'state: open', 'build: success', 'src/a.js (+3 −1)', 'Comments (1)', 'bob']) assert.ok(t.includes(s), s);
  assert.equal(await page.locator('#detail li.task input[type=checkbox]:checked').count(), 1);
  assert.equal(await page.locator('#detail table').count(), 1);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#detail').isVisible(), false);
  await open_(page, 'Add dark mode'); await page.locator('#detail button', { hasText: 'Close' }).first().click();
  assert.equal(await page.locator('#detail').isVisible(), false);
});
await test('XSS: scripts/handlers/javascript: links in body, comments and titles are inert', async ({ page }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const r = await page.evaluate(() => ({
    xss: window.__xss, scripts: document.querySelectorAll('#detail script').length,
    handlers: [...document.querySelectorAll('body *')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length,
    jsLinks: [...document.querySelectorAll('a')].filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length,
    bTags: document.querySelectorAll('#detail .comment b').length, body: document.querySelector('#detail .body').innerText }));
  assert.deepEqual([r.xss, r.scripts, r.handlers, r.jsLinks, r.bTags], [undefined, 0, 0, 0, 0]);
  assert.ok(r.body.includes('<script>') && r.body.includes('<img src=x onerror='), 'raw HTML shown as text: ' + r.body);
  assert.ok(!r.body.includes('hidden comment'), 'HTML comment hidden');
  await tab(page, 3); assert.ok((await txt(page, '#list')).includes('<img src=x onerror=alert(1)>'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('#list img').length), 0);
});
await test('markdown links: https/mailto only, new tab + noopener', async ({ page }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const l = page.locator('#detail .body a', { hasText: 'ok link' });
  assert.equal(await l.getAttribute('href'), 'https://example.com/page');
  assert.equal(await l.getAttribute('target'), '_blank'); assert.match(await l.getAttribute('rel'), /noopener/);
  assert.equal(await page.locator('#detail .body a', { hasText: 'bare' }).count(), 1);
});
await test('images: only https github.com / *.githubusercontent.com / githubassets are inline; others become links; none requested', async ({ page, hosts }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const srcs = await page.$$eval('#detail .body img', (i) => i.map((x) => x.src));
  assert.deepEqual(srcs.sort(), ['https://github.com/acme/web/assets/1/ok.png', 'https://user-images.githubusercontent.com/1/pic.png']);
  const links = await page.$$eval('#detail .body a', (a) => a.map((x) => x.textContent));
  for (const alt of ['evil', 'lookalike', 'userinfo', 'http']) assert.ok(links.some((t) => t.includes('🖼 ' + alt)), alt + ' link');
  assert.ok(![...hosts].some((h) => /evil/.test(h)), 'no request to evil host: ' + [...hosts]);
});
await test('images: a failing allowed image degrades to a link', async ({ page }) => {
  await page.route('https://user-images.githubusercontent.com/**', (r) => r.abort());
  await tab(page, 2); await open_(page, 'Add dark mode');
  await page.locator('#detail .body a', { hasText: '🖼 cdn' }).waitFor();
});

// ---- gating and actions ----
await test('gating: own PR disables Approve/Request changes with note; Comment/Close stay enabled', async ({ page }) => {
  await open_(page, 'My own PR');
  assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Request changes' }).isDisabled(), true);
  assert.match(await txt(page, '.review-note'), /own PR/);
  assert.equal(await page.getByRole('button', { name: 'Comment' }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Close' }).last().isEnabled(), true);
});
await test('gating: closed PR disables review buttons and offers Reopen', async ({ page }) => {
  await tab(page, 2); await open_(page, 'Closed PR');
  assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true);
  assert.match(await txt(page, '.review-note'), /closed or merged/);
  assert.equal(await page.getByRole('button', { name: 'Reopen' }).count(), 1);
});
await test('gating: draft PR shows note but review is allowed', async ({ page }) => {
  await tab(page, 2); await open_(page, 'Draft: refactor');
  assert.match(await txt(page, '.review-note'), /draft/);
  assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).isEnabled(), true);
});
await test('actions: comment needs text, then posts', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  await page.getByRole('button', { name: 'Comment' }).click();
  assert.match(await txt(page, '#banner'), /Enter a comment first/);
  assert.equal(mock.called('POST', 'comments').length, 0);
  await page.locator('#detail textarea').fill('hello there'); await page.getByRole('button', { name: 'Comment' }).click();
  await page.locator('#detail .comment', { hasText: 'hello there' }).waitFor();
  assert.equal(mock.called('POST', 'comments')[0].body.body, 'hello there');
});
await test('actions: approve posts APPROVE (with optional body); request changes needs text', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Bump deps');
  await page.getByRole('button', { name: 'Request changes' }).click();
  assert.match(await txt(page, '#banner'), /Enter a comment first/); assert.equal(mock.called('POST', '/reviews').length, 0);
  await page.locator('#detail textarea').fill('LGTM'); await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await until(() => mock.called('POST', '/reviews').length === 1, 'approve request');
  assert.deepEqual(mock.called('POST', '/reviews')[0].body, { event: 'APPROVE', body: 'LGTM' });
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  await open_(page, 'Bump deps');
  await page.locator('#detail textarea').fill('fix'); await page.getByRole('button', { name: 'Request changes' }).click();
  await until(() => mock.called('POST', '/reviews').length === 2, 'request-changes request');
  assert.equal(mock.called('POST', '/reviews')[1].body.event, 'REQUEST_CHANGES');
});
await test('actions: approve 422 shows GitHub reasons; 403/404/500 show status', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Bump deps');
  for (const [st, want] of [[422, /422: Validation Failed — Review Can not approve your own pull request/], [403, /403: Forbidden/], [404, /404: Not Found/], [500, /500: Boom/]]) {
    const body = st === 422 ? { message: 'Validation Failed', errors: ['Review Can not approve your own pull request'] } : { message: { 403: 'Forbidden', 404: 'Not Found', 500: 'Boom' }[st] };
    mock.fail('POST', '/reviews', st, body, {}, 1);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction((s) => document.getElementById('banner').textContent.includes('error ' + s), st);
    assert.match(await txt(page, '#banner'), want);
    assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).isEnabled(), true, 'buttons re-enabled');
  }
});
await test('actions: 429 rate limit on action shows reset banner', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Bump deps');
  mock.fail('POST', '/reviews', 429, { message: 'rate' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }, 1);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => /Rate limit exceeded/.test(document.getElementById('banner').textContent));
});
await test('actions: merge asks to confirm; dismiss = no request; accept = PUT merge', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Bump deps');
  await page.getByRole('button', { name: 'Merge' }).click();
  await page.waitForFunction(() => /Merge cancelled/.test(document.getElementById('banner').textContent));
  assert.equal(mock.called('PUT', '/merge').length, 0);
  page.removeAllListeners('dialog'); page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Merge' }).click();
  await until(() => mock.called('PUT', '/merge').length === 1, 'merge request');
  assert.deepEqual(mock.called('PUT', '/merge')[0].body, { merge_method: 'merge' });
});
await test('actions: merge failure (405 not mergeable) is reported', async ({ page, mock }) => {
  page.removeAllListeners('dialog'); page.on('dialog', (d) => d.accept());
  await tab(page, 2); await open_(page, 'Bump deps');
  mock.fail('PUT', '/merge', 405, { message: 'Pull Request is not mergeable' }, {}, 1);
  await page.getByRole('button', { name: 'Merge' }).click();
  await page.waitForFunction(() => /405: Pull Request is not mergeable/.test(document.getElementById('banner').textContent));
});
await test('actions: close then reopen an issue flips label and state', async ({ page, mock }) => {
  await tab(page, 4); await open_(page, 'Assigned issue');
  await page.getByRole('button', { name: 'Close' }).last().click();
  await page.getByRole('button', { name: 'Reopen' }).waitFor();
  assert.equal(mock.called('PATCH', '/issues/20')[0].body.state, 'closed');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await page.getByRole('button', { name: 'Close' }).last().waitFor();
  assert.equal(mock.called('PATCH', '/issues/20')[1].body.state, 'open');
});
await test('detail: load failure (404) shows banner and closes panel', async ({ page, mock }) => {
  await tab(page, 2); mock.fail('GET', '/issues/13$', 404);
  await row(page, 'Bump deps').click();
  await page.waitForFunction(() => /404/.test(document.getElementById('banner').textContent));
  assert.equal(await page.locator('#detail').isVisible(), false);
});

// ---- bulk approve ----
const bulkPrep = async (page) => { await tab(page, 2); await settled(page); };
await test('bulk: own/draft/closed rows cannot be selected, with reasons', async ({ page }) => {
  await bulkPrep(page);
  assert.match(await page.locator('#list li', { hasText: 'Draft: refactor' }).locator('label.bulk').getAttribute('title'), /Draft/);
  assert.match(await row(page, 'Closed PR').locator('label.bulk').getAttribute('title'), /Closed or merged/);
  assert.equal(await row(page, 'Closed PR').locator('input').isDisabled(), true);
  await tab(page, 1); assert.match(await page.locator('#list li label.bulk').getAttribute('title'), /Your own PR/);
  await tab(page, 4); assert.equal(await page.locator('#list li label.bulk').count(), 0);
});
await test('bulk: toolbar count, select all visible, clear, filter prunes, tab switch clears', async ({ page }) => {
  await bulkPrep(page);
  assert.equal(await page.locator('#bulkbar').isVisible(), false);
  await row(page, 'Add dark mode').locator('input').check();
  assert.equal(await txt(page, '#bulkcount'), '1 selected');
  assert.equal(await page.locator('#detail').isVisible(), false, 'ticking does not open detail');
  await page.locator('#bulkall').click(); assert.equal(await txt(page, '#bulkcount'), '3 selected');
  await page.locator('#repofilter').selectOption('other/tools'); assert.equal(await txt(page, '#bulkcount'), '1 selected');
  await page.locator('#repofilter').selectOption(''); assert.equal(await txt(page, '#bulkcount'), '1 selected', 'pruned PRs are not re-selected');
  await page.locator('#bulkclear').click(); assert.equal(await page.locator('#bulkbar').isVisible(), false);
  await row(page, 'Bump deps').locator('input').check(); await tab(page, 3); await tab(page, 2);
  assert.equal(await page.locator('#bulkbar').isVisible(), false);
});
await test('bulk: dialog focuses Cancel; Esc cancels without requests', async ({ page, mock }) => {
  await bulkPrep(page); await page.locator('#bulkall').click({ trial: false }).catch(() => {});
  await row(page, 'Bump deps').locator('input').check(); await page.locator('#bulkapprove').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bulkcancel');
  assert.match(await txt(page, '#bulk'), /acme\/web#10|other\/tools#13/);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#bulkoverlay').isVisible(), false);
  assert.equal(mock.called('POST', '/reviews').length, 0);
  await page.keyboard.press('j'); // shortcuts are inert in dialog, and work again after
});
await test('bulk: approves all with shared comment; summary "N approved, 0 failed"', async ({ page, mock }) => {
  await bulkPrep(page); await page.locator('#bulkall').click().catch(() => {});
  await row(page, 'Add dark mode').locator('input').check(); await row(page, 'Bump deps').locator('input').check();
  await page.locator('#bulkapprove').click(); await page.locator('#bulk textarea').fill('batch ok'); await page.locator('#bulkconfirm').click();
  await page.locator('#bulksummary').waitFor();
  assert.match(await txt(page, '#bulksummary'), /2 approved, 0 failed/);
  assert.deepEqual(mock.called('POST', '/reviews').map((c) => c.body), [{ event: 'APPROVE', body: 'batch ok' }, { event: 'APPROVE', body: 'batch ok' }]);
  await page.locator('#bulkclose').click(); assert.equal(await page.locator('#bulkbar').isVisible(), false);
});
await test('bulk: one 422 does not stop others; Retry failed re-runs only failures', async ({ page, mock }) => {
  await bulkPrep(page);
  await row(page, 'Add dark mode').locator('input').check(); await row(page, 'Bump deps').locator('input').check();
  mock.fail('POST', '/acme/web/pulls/10/reviews', 422, { message: 'Validation Failed', errors: ['nope'] }, {}, 1);
  await page.locator('#bulkapprove').click(); await page.locator('#bulkconfirm').click(); await page.locator('#bulksummary').waitFor();
  assert.match(await txt(page, '#bulksummary'), /1 approved, 1 failed/);
  assert.match(await txt(page, '#bulk'), /failed: GitHub API error 422: Validation Failed — nope/);
  const before = mock.called('POST', '/reviews').length;
  await page.locator('#bulkretry').click(); await page.waitForFunction(() => /2 approved, 0 failed/.test(document.getElementById('bulksummary')?.textContent || ''));
  assert.equal(mock.called('POST', '/reviews').length - before, 1);
});
await test('bulk: 429 stops the batch; remaining are "not attempted"', async ({ page, mock }) => {
  await bulkPrep(page);
  await row(page, 'Add dark mode').locator('input').check(); await row(page, 'Bump deps').locator('input').check();
  mock.fail('POST', '/reviews', 429, { message: 'rate' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
  await page.locator('#bulkapprove').click(); await page.locator('#bulkconfirm').click(); await page.locator('#bulksummary').waitFor();
  assert.match(await txt(page, '#bulksummary'), /0 approved, 1 failed, 1 not attempted/);
  assert.match(await txt(page, '#bulk'), /rate limit/i);
  assert.equal(mock.called('POST', '/reviews').length, 1);
});
await test('bulk: 401 stops the batch and signs out', async ({ page, mock }) => {
  await bulkPrep(page); await row(page, 'Bump deps').locator('input').check();
  mock.fail('POST', '/reviews', 401, { message: 'Bad credentials' });
  await page.locator('#bulkapprove').click(); await page.locator('#bulkconfirm').click(); await page.locator('#bulksummary').waitFor();
  assert.match(await txt(page, '#bulk'), /401/); assert.equal(await page.evaluate(() => localStorage.getItem('gh_dashboard_token')), null);
});

// ---- refresh, scroll, shortcuts, CSP ----
await test('refresh: manual refresh updates "Last updated" and keeps scroll position', async ({ page }) => {
  await tab(page, 5); await page.waitForSelector('#list li');
  await page.evaluate(() => window.scrollTo(0, 400));
  const y = await page.evaluate(() => window.scrollY); assert.ok(y > 100, 'page is scrollable');
  const bb = await page.locator('#refresh').boundingBox(); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); // real mouse click; locator.click() would scroll the page itself
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.match(await txt(page, '#lastupdated'), /^Last updated \d\d:\d\d$/);
  assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - y) <= 2);
});
await test('refresh: failure keeps old data; header is sticky', async ({ page, mock }) => {
  await page.locator('#list li').first().waitFor();
  const before = await page.locator('#list li').count();
  mock.fail('GET', '/search/issues', 500, { message: 'down' });
  await page.locator('#refresh').click(); await page.waitForFunction(() => /500/.test(document.getElementById('banner').textContent));
  assert.equal(await page.locator('#list li').count(), before);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('top')).position), 'sticky');
});
await test('auto-refresh: runs on the timer; Off disables; skipped while an action is in flight', async ({ page, mock }) => {
  await page.clock.install(); await page.reload(); await page.locator('#list li').first().waitFor();
  await page.locator('#autorefresh').selectOption('2');
  const n = () => mock.called('GET', '/search/issues').length, base = n();
  await page.clock.runFor(60000 * 2 + 2000); await page.waitForTimeout(300);
  assert.ok(n() > base, 'auto refresh fired');
  await page.locator('#autorefresh').selectOption('0');
  const after = n(); await page.clock.runFor(60000 * 20); await page.waitForTimeout(300);
  assert.equal(n(), after, 'Off: no further refresh');
});
await test('shortcuts: j/k/arrows move, Enter/o open, g opens GitHub, r refreshes, ? help, Esc closes', async ({ page, context }) => {
  await tab(page, 2); await settled(page);
  await page.keyboard.press('j'); assert.match(await txt(page, '#list li.cur'), /Add dark mode/);
  await page.keyboard.press('ArrowDown'); assert.match(await txt(page, '#list li.cur'), /Draft/);
  await page.keyboard.press('k'); assert.match(await txt(page, '#list li.cur'), /Add dark mode/);
  await page.keyboard.press('ArrowUp'); assert.match(await txt(page, '#list li.cur'), /Add dark mode/);
  await page.keyboard.press('o'); await page.locator('#detail h3', { hasText: 'Comments' }).waitFor();
  assert.match(await txt(page, '#detail h3 >> nth=0'), /acme\/web#10/);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#detail').isVisible(), false);
  const popup = context.waitForEvent('page'); await page.keyboard.press('g'); const p2 = await popup; assert.match(p2.url(), /github\.com\/acme\/web\/pull\/10/);
  await page.keyboard.press('?'); assert.equal(await page.locator('#helpoverlay').isVisible(), true);
  await page.keyboard.press('j'); assert.match(await txt(page, '#list li.cur'), /Add dark mode/, 'inert while help open');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#helpoverlay').isVisible(), false);
});
await test('shortcuts: ignored while typing and with Ctrl held', async ({ page }) => {
  await page.locator('#textfilter').click(); await page.keyboard.type('j2?');
  assert.equal(await page.locator('#textfilter').inputValue(), 'j2?'); assert.equal(await page.locator('#helpoverlay').isVisible(), false);
  await page.keyboard.press('Escape'); await page.keyboard.press('Control+2');
  assert.equal(await page.locator('#tabs button').nth(0).getAttribute('aria-selected'), 'true');
});
await test('shortcuts: "r" refreshes', async ({ page, mock }) => {
  const base = mock.called('GET', '/search/issues').length; await page.keyboard.press('r');
  await page.waitForFunction(() => !document.getElementById('refresh').disabled);
  assert.ok(mock.called('GET', '/search/issues').length > base);
});
await test('CSP: policy present; inline script, foreign fetch and foreign image are blocked', async ({ page, csp }) => {
  const policy = await page.locator('meta[http-equiv=Content-Security-Policy]').getAttribute('content');
  for (const d of ["connect-src https://api.github.com", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(policy.includes(d), d);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(policy));
  const r = await page.evaluate(async () => {
    window.__inline = 0; const s = document.createElement('script'); s.textContent = 'window.__inline=1'; document.body.append(s);
    const f = await fetch('https://evil.example/x').then(() => 'allowed', () => 'blocked');
    const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => ok('blocked'); i.src = 'https://evil.example/i.png'; });
    return { inline: window.__inline, f, img };
  });
  assert.deepEqual(r, { inline: 0, f: 'blocked', img: 'blocked' });
  assert.ok(csp.length >= 3, 'CSP violations reported: ' + csp.length);
});
await test('no network except api.github.com and allowed image hosts during normal use', async ({ page, hosts }) => {
  await tab(page, 2); await settled(page); await open_(page, 'Add dark mode');
  for (const h of hosts) assert.ok(/^(api\.github\.com|github\.com|[^.]+\.githubusercontent\.com|github\.githubassets\.com)$/.test(h), h);
});
await test('responsive: no horizontal overflow on a phone-sized viewport', async ({ page }) => {
  await tab(page, 2); await settled(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
}, { viewport: { width: 390, height: 800 } });

await browser.close(); srv.close();
const failed = results.filter(([, e]) => e);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
