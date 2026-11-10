// Mocked-API end-to-end checks. Usage: node tests/run.mjs [name-filter]
import assert from 'node:assert/strict';
import { loadPlaywright, launchBrowser, serve, open, settled } from './lib.mjs';

const pw = loadPlaywright();
const { srv, url } = await serve();
const browser = await launchBrowser(pw);
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
  await page.locator('#token').fill('bad'); await page.locator('#loginform button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('banner').textContent.includes('401'));
  assert.equal(await page.locator('#login').isVisible(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('gh_dashboard_token')), null);
}, { token: null });
await test('login: good token loads lists, stores token, shows user', async ({ page }) => {
  await page.locator('#token').fill('good'); await page.locator('#loginform button[type=submit]').click();
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
await test('tabs: six tabs with counts; keys 1-6 switch', async ({ page }) => {
  await page.locator('#list li').first().waitFor();
  assert.equal(await page.locator('#tabs button').count(), 6);
  const counts = await page.locator('#tabs .count').allInnerTexts();
  assert.deepEqual(counts, ['1', '5', '2', '1', '30', '0']);
  for (let n = 1; n <= 6; n++) { await page.keyboard.press(String(n)); assert.equal(await page.locator('#tabs button').nth(n - 1).getAttribute('aria-selected'), 'true'); }
});
const DAY = 86400000, daysAgo = (d) => new Date(Date.now() - d * DAY - 60000).toISOString();
function ageItems(mock) {
  const by = (n) => mock.items.find((i) => i.number === n);
  // review tab: 10 (8d, also assigned), 11 draft (20d), 13 (40d), 14 (2d), 15 closed (20d); 12 only mentioned (40d); issue 20 assigned (6d)
  for (const [n, d] of [[10, 8], [11, 20], [13, 40], [14, 2], [15, 20], [12, 40], [20, 6]]) by(n).created_at = daysAgo(d);
  by(10).assignees = [{ login: 'me' }]; by(20).assignees = [{ login: 'me' }]; by(12).assignees = [{ login: 'someone' }];
}
await test('waiting tab: filtered, de-duplicated, oldest first, threshold persists', async ({ page, mock }) => {
  ageItems(mock);
  await page.locator('#refresh').click(); await page.locator('#list li').first().waitFor(); await settled(page);
  await page.keyboard.press('6');
  assert.equal(await page.locator('#waitbox').isVisible(), true);
  assert.equal(await page.locator('#waitdays').inputValue(), '7');
  const titles = () => page.locator('#list .row-title').allInnerTexts();
  assert.deepEqual((await titles()).map((t) => t.trim()), ['Bump deps', 'Draft: refactor router', 'Closed PR', 'Add dark mode']);
  assert.equal(await txt(page, '#tabs button[aria-selected=true] .count'), '4');
  assert.match(await txt(page, '#list li:first-child .wait'), /waiting 40 days \(since opened, long overdue\)/);
  assert.match(await txt(page, '#list li:last-child .wait'), /^waiting 8 days \(since opened\)$/);
  assert.equal(await page.locator('#list li:last-child .wait-warn').count(), 1);
  // own/closed/draft stay unselectable
  assert.equal(await row(page, 'Draft: refactor router').locator('input').isDisabled(), true);
  assert.equal(await row(page, 'Closed PR').locator('input').isDisabled(), true);
  assert.equal(await row(page, 'Bump deps').locator('input').isDisabled(), false);
  await page.locator('#waitdays').selectOption('3');
  assert.equal(await page.locator('#list li').count(), 5); // + issue 20 (6d)
  await page.locator('#waitdays').selectOption('30');
  assert.deepEqual((await titles()).map((t) => t.trim()), ['Bump deps']);
  await page.reload(); await page.locator('#list li').first().waitFor();
  assert.equal(await page.locator('#waitdays').inputValue(), '30');
  assert.match(await txt(page, '#tabs button[aria-selected=true]'), /Waiting on me/);
  await page.locator('#waitdays').selectOption('7');
  await page.locator('#textfilter').fill('zzz');
  assert.equal((await txt(page, '#list li.empty')).trim(), 'Nothing has been waiting on you for more than 7 days.');
});
const evAt = (days) => new Date(Date.now() - days * DAY_MS_T).toISOString();
const DAY_MS_T = 86400000;
const reqEv = (days, login) => ({ event: 'review_requested', created_at: evAt(days), requested_reviewer: { login } });
const rmEv = (days, login) => ({ event: 'review_request_removed', created_at: evAt(days), requested_reviewer: { login } });
function timeline(mock) {
  ageItems(mock);
  const by = (n) => mock.items.find((x) => x.number === n);
  by(20).created_at = evAt(12);
  by(13).events = [{ event: 'review_requested', created_at: evAt(12), requested_team: { slug: 'core' } }]; // team request only
  by(11).events = [reqEv(20, 'me'), rmEv(15, 'me'), reqEv(9, 'me')]; // re-request resets the clock
  by(15).events = [reqEv(20, 'me'), rmEv(3, 'me')]; // request withdrawn: not waiting
  by(10).events = [reqEv(2, 'me'), { event: 'assigned', created_at: evAt(7.5), assignee: { login: 'me' } }, reqEv(1, 'other')]; // assigned path is older
  by(20).events = [{ event: 'assigned', created_at: evAt(9), assignee: { login: 'me' } }];
}
await test('waiting tab: age from request/assignment time, reset, removal, team, fallback, cache', async ({ page, mock }) => {
  timeline(mock);
  await page.locator('#refresh').click(); await settled(page);
  await page.keyboard.press('6');
  await until(async () => (await page.locator('#list .wait-check:not(.done)').count()) === 0, 'checks to finish');
  const rows = async () => (await page.locator('#list li').all()).length ? page.locator('#list li').evaluateAll((ls) => ls.map((l) => [l.querySelector('.row-title').textContent.trim(), l.querySelector('.wait').textContent])) : [];
  assert.deepEqual(await rows(), [
    ['Bump deps', 'waiting 12 days (since requested)'], // team request
    ['Draft: refactor router', 'waiting 9 days (since requested)'], // re-request after removal
    ['Assigned issue', 'waiting 9 days (since assigned)'], // created 12d ago
    ['Add dark mode', 'waiting 7 days (since assigned)'], // created 8d, review requested 2d, assigned 7.5d: oldest path wins
  ]);
  assert.equal(await row(page, 'Closed PR').count(), 0, 'withdrawn request excluded');
  assert.equal(await txt(page, '#tabs button[aria-selected=true] .count'), '4');
  assert.equal(await page.locator('#waitbanner').isVisible(), false);
  const n = mock.called('GET', '/events').length;
  assert.equal(n, 5, 'one events request per old candidate'); // 10, 11, 13, 15, 20; #14 (2d) is skipped
  await page.locator('#refresh').click(); await settled(page);
  await page.waitForTimeout(500);
  assert.equal(mock.called('GET', '/events').length, n, 'cache avoids refetch on refresh');
  await page.reload(); await page.locator('#list li').first().waitFor(); await settled(page); await page.waitForTimeout(500);
  assert.equal(mock.called('GET', '/events').length, n, 'localStorage cache avoids refetch after reload');
  assert.match(await txt(page, '#list li:first-child .wait'), /since (requested|assigned)/);
  await page.locator('#signout').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('gh_dashboard_wait_cache')), null);
}, { storage: { gh_dashboard_tab: 'waiting' } });
await test('waiting tab: cached request times of another login are ignored', async ({ page, mock }) => {
  timeline(mock);
  const it = mock.items.find((x) => x.number === 13);
  const seeded = { [String(it.id)]: { m: 'someone-else', u: it.updated_at, p: 'r', t: Date.now() - 100 * DAY_MS_T, k: 'requested', x: false, s: Date.now() } };
  await page.evaluate((c) => { localStorage.setItem('gh_dashboard_wait_cache', JSON.stringify(c)); }, seeded);
  await page.reload(); await page.locator('#list li').first().waitFor(); await settled(page);
  await until(async () => (await page.locator('#list .wait-check:not(.done)').count()) === 0, 'checks to finish');
  assert.match(await txt(page, '#list li:has-text("Bump deps") .wait'), /^waiting 12 days \(since requested\)$/);
  assert.ok(mock.called('GET', '/issues/13/events').length >= 1, 'events refetched for this login');
}, { storage: { gh_dashboard_tab: 'waiting' } });
await test('waiting tab: exact date per source as tooltip, keyboard focus, screen reader text', async ({ page, mock }) => {
  timeline(mock);
  const by = (n) => mock.items.find((x) => x.number === n);
  await page.locator('#refresh').click(); await settled(page);
  await until(async () => (await page.locator('#list .wait-check:not(.done)').count()) === 0, 'checks to finish');
  const DATE = '\\w{3} \\d{1,2} \\w{3} \\d{4}, \\d\\d:\\d\\d \\(\\S+\\)';
  const info = (title) => row(page, title).locator('button.wait').evaluate((b) => ({ title: b.title, desc: document.getElementById(b.getAttribute('aria-describedby')).textContent, iso: document.getElementById(b.getAttribute('aria-describedby')).querySelector('time').getAttribute('datetime') }));
  const cases = [['Draft: refactor router', 'Review requested', evAt(9)], ['Bump deps', 'Requested via team core', evAt(12)], ['Assigned issue', 'Assigned', evAt(9)], ['Add dark mode', 'Assigned', evAt(7.5)]];
  for (const [title, label, iso] of cases) {
    const r = await info(title);
    assert.match(r.title, new RegExp(`^${label} ${DATE}$`), title);
    assert.match(r.desc, new RegExp(`^${label} ${DATE}$`), title);
    assert.ok(Math.abs(new Date(r.iso) - new Date(iso)) < 5000, title + ' datetime ' + r.iso);
  }
  // keyboard: focusable, shows the overlay, does not open the row; Escape hides it
  const btn = row(page, 'Bump deps').locator('button.wait');
  await btn.focus();
  assert.equal(await page.locator('#waittip').isVisible(), true);
  assert.match(await txt(page, '#waittip'), /^Requested via team core /);
  const box = await page.locator('#waittip').boundingBox(), vw = page.viewportSize().width;
  assert.ok(box.x >= 0 && box.x + box.width <= vw, 'overlay inside viewport');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#detail').isHidden(), true, 'Enter on the date label must not open the item');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#waittip').isHidden(), true);
  // overlay does not move rows; tab order reaches the label; checkbox still works
  const hs = await page.locator('#list li').evaluateAll((ls) => ls.map((l) => l.offsetHeight));
  await btn.click();
  assert.deepEqual(await page.locator('#list li').evaluateAll((ls) => ls.map((l) => l.offsetHeight)), hs);
  assert.equal(await page.locator('#detail').isHidden(), true, 'clicking the label must not open the item');
  await row(page, 'Bump deps').locator('input').check();
  assert.equal(await txt(page, '#bulkcount'), '1 selected');
  // opened fallback wording
  mock.items.forEach((x) => { x.events = []; });
  by(10).updated_at = new Date().toISOString(); // new cache key
  const before = mock.called('GET', '/events').length;
  await page.locator('#refresh').click(); await settled(page);
  await until(async () => mock.called('GET', '/events').length > before && (await page.locator('#list .wait-check:not(.done)').count()) === 0, 'refetch');
  const o = await info('Add dark mode');
  assert.match(o.title, new RegExp(`^Opened \\(no request/assignment event found\\) ${DATE}$`));
}, { storage: { gh_dashboard_tab: 'waiting' }, viewport: { width: 375, height: 800 } });
// ---- keyboard focus survives list re-renders ----
const focusId = (page) => page.evaluate(() => { const a = document.activeElement, li = a && a.closest && a.closest('#list li'); return li ? { row: li.querySelector('.row-title').textContent, tag: a.tagName, cls: a.className } : { body: a === document.body, id: a.id }; });
const markOld = (page) => page.evaluate(() => document.querySelectorAll('#list li').forEach((l) => { l.dataset.old = '1'; }));
const rebuilt = (page) => until(async () => (await page.locator('#list li[data-old]').count()) === 0 && (await page.locator('#list .wait-check:not(.done)').count()) === 0 && (await page.locator('#list .st-loading').count()) === 0, 'list rebuilt and settled');
const churn = (mock) => mock.items.forEach((x, n) => { if (x.pull_request) { x.updated_at = new Date(Date.now() - 1000 * (n + 1)).toISOString(); x.ci = x.ci === 'success' ? 'failure' : 'success'; } });
const FOCUS_TARGETS = { 'row': (p) => row(p, 'Bump deps'), 'checkbox': (p) => row(p, 'Bump deps').locator('input'), 'date label with overlay': (p) => row(p, 'Bump deps').locator('button.wait') };
const WAITING = { storage: { gh_dashboard_tab: 'waiting' } };
for (const [what, loc] of Object.entries(FOCUS_TARGETS)) {
  const check = async (page, manual) => {
    const f = await focusId(page);
    assert.equal(f.row, 'Bump deps', `${what} keeps focus after re-render`);
    assert.equal(f.tag, what === 'row' ? 'LI' : what === 'checkbox' ? 'INPUT' : 'BUTTON');
    if (manual) return; // the click on Refresh itself dismisses the overlay (any click outside a date label does)
    assert.equal(await page.locator('#waittip').isVisible(), what === 'date label with overlay', 'overlay only open for the date label');
    if (what === 'date label with overlay') assert.match(await txt(page, '#waittip'), /^Requested via team core /);
  };
  await test(`focus: ${what} keeps focus on manual Refresh with changed statuses`, async ({ page, mock }) => {
    timeline(mock); await page.locator('#refresh').click(); await rebuilt(page);
    await loc(page).focus(); await markOld(page); churn(mock);
    await page.evaluate(() => document.getElementById('refresh').click()); // a real click would move focus to the button itself
    await rebuilt(page); await check(page, true);
  }, WAITING);
  await test(`focus: ${what} keeps focus on auto refresh with changed statuses`, async ({ page, mock }) => {
    timeline(mock); await page.clock.install(); await page.reload(); await page.locator('#list li').first().waitFor(); await rebuilt(page);
    await loc(page).focus(); await markOld(page); churn(mock);
    await page.clock.runFor(5 * 60 * 1000 + 2000); await rebuilt(page); await check(page);
  }, WAITING);
  await test(`focus: ${what} keeps focus through late status renders`, async ({ page, mock }) => {
    timeline(mock); await page.locator('#list li').first().waitFor();
    await row(page, 'Bump deps').waitFor(); await markOld(page); await loc(page).focus();
    await rebuilt(page); await check(page);
  }, WAITING);
}
await test('focus: not stolen from the text filter while typing through a refresh', async ({ page, mock }) => {
  await settled(page); await page.locator('#textfilter').focus(); await page.keyboard.type('da');
  churn(mock); await markOld(page); await page.evaluate(() => document.getElementById('refresh').click()); await rebuilt(page);
  await page.keyboard.type('rk');
  assert.equal(await page.locator('#textfilter').inputValue(), 'dark');
  assert.deepEqual(await focusId(page), { body: false, id: 'textfilter' });
});
await test('focus: falls back to the row now in its place when the focused item vanishes', async ({ page, mock }) => {
  timeline(mock); await page.locator('#refresh').click(); await rebuilt(page);
  const titles = await page.locator('#list li .row-title').allInnerTexts();
  assert.ok(titles.length >= 3);
  await page.locator('#list li').nth(1).focus(); await markOld(page);
  const gone = mock.items.find((x) => titles[1].includes(x.title)); gone.assignees = []; gone.requested_reviewers = []; gone.state = 'closed'; gone.vanished = true;
  mock.items.splice(mock.items.indexOf(gone), 1);
  await page.evaluate(() => document.getElementById('refresh').click()); await rebuilt(page);
  const f = await focusId(page);
  assert.equal(f.tag, 'LI', 'focus lands on a row, not the page body');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#list li')].indexOf(document.activeElement)), 1);
}, WAITING);
// ---- the open detail panel survives refreshes ----
const longDetail = (mock) => { const it = mock.items.find((x) => x.title === 'Add dark mode'); for (let n = 0; n < 40; n++) it.comments.push({ user: { login: 'bob' }, created_at: evAt(1), body: 'filler comment ' + n }); };
const detailState = (page) => page.evaluate(() => { const ta = document.querySelector('#detail textarea'); return { top: document.getElementById('detail').scrollTop, hidden: document.getElementById('detail').hidden, focusTa: !!ta && document.activeElement === ta, val: ta && ta.value, sel: ta && [ta.selectionStart, ta.selectionEnd] }; });
const tall = { viewport: { width: 1280, height: 420 } };
for (const how of ['manual', 'auto']) {
  await test(`detail: scroll position, typed comment, focus and caret survive ${how} refresh`, async ({ page, mock }) => {
    longDetail(mock);
    if (how === 'auto') { await page.clock.install(); await page.reload(); }
    await tab(page, 2); await settled(page); await open_(page, 'Add dark mode');
    const ta = page.locator('#detail textarea');
    await page.evaluate(() => { const d = document.getElementById('detail'); d.scrollTop = d.scrollHeight; });
    await ta.fill('half-written thought'); await ta.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    const before = await detailState(page);
    assert.ok(before.top > 100, 'detail is scrolled');
    assert.deepEqual(before.sel, [18, 18]);
    await markOld(page); churn(mock);
    if (how === 'manual') await page.evaluate(() => document.getElementById('refresh').click()); else await page.clock.runFor(5 * 60 * 1000 + 2000);
    await rebuilt(page);
    const after = await detailState(page);
    assert.deepEqual(after, before, 'scroll, text, focus and caret unchanged');
  }, tall);
}
await test('waiting tab: shortcuts work with the date label focused; team slug HTML stays inert; bad dates never print Invalid Date', async ({ page, mock }) => {
  timeline(mock);
  const by = (n) => mock.items.find((x) => x.number === n);
  by(13).events = [{ event: 'review_requested', created_at: evAt(12), requested_team: { slug: '<img src=x onerror=window.__xss=9>' } }];
  await page.locator('#refresh').click(); await settled(page);
  await until(async () => (await page.locator('#list .wait-check:not(.done)').count()) === 0, 'checks to finish');
  const btn = row(page, 'Bump deps').locator('button.wait');
  await btn.focus();
  assert.match(await txt(page, '#waittip'), /^Requested via team <img src=x onerror=window\.__xss=9> /);
  assert.equal(await page.locator('#waittip img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.keyboard.press('j');
  assert.equal(await page.locator('#list li.cur').count(), 1, 'j moves the cursor while the label is focused');
  await page.keyboard.press('?');
  assert.equal(await page.locator('#helpoverlay').isVisible(), true, '? opens help while the label is focused');
  await page.keyboard.press('Escape');
  await btn.focus(); await page.keyboard.press('2');
  assert.equal(await txt(page, '#tabs button[aria-selected=true]').then((t) => /\S/.test(t)), true);
  assert.notEqual(await page.evaluate(() => localStorage.getItem('gh_dashboard_tab')), 'waiting', '2 switches tab');
}, { storage: { gh_dashboard_tab: 'waiting' } });
await test('waiting tab: invalid created_at shows no Invalid Date/null/undefined', async ({ page, mock }) => {
  timeline(mock);
  mock.items.find((x) => x.number === 20).created_at = 'garbage';
  mock.items.find((x) => x.number === 20).events = [];
  await page.locator('#refresh').click(); await settled(page);
  await page.waitForTimeout(800);
  const all = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[title]')].map((e) => e.title).join(' ') + document.getElementById('waittip').textContent);
  assert.doesNotMatch(all, /Invalid Date|undefined|\bnull\b/);
}, { storage: { gh_dashboard_tab: 'waiting' } });
await test('waiting tab: events failure falls back to opened date with one banner', async ({ page, mock }) => {
  timeline(mock);
  mock.fail('GET', '/events', 403, { message: 'Resource not accessible by personal access token' });
  await page.locator('#refresh').click(); await settled(page);
  await until(async () => await page.locator('#waitbanner').isVisible(), 'banner');
  assert.match(await txt(page, '#waitbanner'), /Issues: Read/);
  await until(async () => (await page.locator('#list .wait-check:not(.done)').count()) === 0, 'checks to finish');
  assert.match(await txt(page, '#list li:first-child .wait'), /\(since opened, long overdue\)/);
  assert.equal(await page.locator('#list li').count(), 5); // 10, 11, 13, 15 and issue 20 by created_at
  const n = mock.called('GET', '/events').length;
  await page.locator('#refresh').click(); await settled(page); await page.waitForTimeout(500);
  assert.equal(mock.called('GET', '/events').length, n, 'failed items are not retried on every refresh');
}, { storage: { gh_dashboard_tab: 'waiting' } });
await test('waiting tab: rate limit on events degrades gracefully', async ({ page, mock }) => {
  timeline(mock);
  mock.fail('GET', '/events', 403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
  await page.locator('#refresh').click(); /* the pause is global, so statuses may legitimately stay unloaded */
  await until(async () => await page.locator('#waitbanner').isVisible(), 'banner');
  assert.match(await txt(page, '#waitbanner'), /Rate limit/i);
  assert.ok(await page.locator('#list li').count() > 0);
}, { storage: { gh_dashboard_tab: 'waiting' } });
await test('waiting tab: invalid saved threshold falls back to 7; empty state', async ({ page }) => {
  await page.keyboard.press('6');
  assert.equal(await page.locator('#waitdays').inputValue(), '7');
  assert.equal((await txt(page, '#list li.empty')).trim(), 'Nothing has been waiting on you for more than 7 days.');
}, { storage: { gh_dashboard_waiting_days: '5' } });
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

// ---- secondary rate limit: one pause gate, escalation, cache ----
const SEC = { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' };
const total = (mock) => mock.calls.length;
const slowBanner = (page) => page.waitForFunction(() => /slow down; automatic updates resume at \d\d:\d\d/.test(document.getElementById('banner').textContent));
const clockPage = async (page, mock) => { await page.clock.install(); await page.reload(); await page.locator('#list li').first().waitFor(); await settled(page).catch(() => {}); mock.calls.length = 0; };
// Expects: no request is sent for `blockFor` seconds (manual refresh included), and requests flow again after `openAfter` seconds.
const expectPause = async (page, mock, blockFor, openAfter) => {
  await page.clock.runFor((blockFor - 2) * 1000);
  const n = total(mock); await page.locator('#refresh').click(); await page.waitForTimeout(150);
  assert.equal(total(mock), n, `no requests while paused (${blockFor}s)`);
  assert.match(await txt(page, '#banner'), /slow down; automatic updates resume at/);
  await page.clock.runFor((openAfter - blockFor + 4) * 1000);
  await page.locator('#refresh').click(); await page.waitForTimeout(250);
  assert.ok(total(mock) > n, `requests flow again after ${openAfter}s`);
};
await test('secondary limit: Retry-After seconds pauses everything; manual Refresh sends nothing and does not extend', async ({ page, mock }) => {
  await clockPage(page, mock);
  const rows = await page.locator('#list li').count();
  mock.fail('GET', '/search/issues', 403, SEC, { 'retry-after': '120' });
  await page.locator('#refresh').click(); await slowBanner(page); await page.waitForTimeout(400);
  const n = total(mock);
  for (let k = 0; k < 3; k++) { await page.locator('#refresh').click(); await page.waitForTimeout(100); }
  await page.clock.runFor(60000); await page.waitForTimeout(100);
  assert.equal(total(mock), n, 'zero requests while paused');
  assert.equal(await page.locator('#list li').count(), rows, 'data preserved');
  mock.faults = [];
  await page.clock.runFor(61000); await page.waitForTimeout(300); // automatic updates resume by themselves when the pause ends
  await page.locator('#refresh').click(); await page.waitForTimeout(300);
  assert.ok(total(mock) > n, 'resumes at the enforced time (not pushed later by blocked refreshes)');
  await page.waitForFunction(() => !/slow down/.test(document.getElementById('banner').textContent));
  assert.equal(await page.locator('#list li').count(), rows);
});
await test('secondary limit: status workers stop cleanly (no further requests) and bulk sends nothing', async ({ page, mock }) => {
  await clockPage(page, mock);
  await tab(page, 2); await settled(page);
  mock.fail('GET', '/pulls/\\d+$', 403, SEC, { 'retry-after': '120' });
  for (const i of mock.items) if (i.pull_request) i.updated_at = new Date().toISOString();
  mock.calls.length = 0;
  await page.locator('#refresh').click(); await slowBanner(page); await page.waitForTimeout(600);
  const n = total(mock); assert.ok(mock.called('GET', '/pulls/\\d+$').length <= 3, 'only in-flight requests were sent');
  await row(page, 'Bump deps').locator('input').check();
  await page.locator('#bulkapprove').click(); await page.locator('#bulkconfirm').click(); await page.locator('#bulksummary').waitFor();
  await page.clock.runFor(30000); await page.waitForTimeout(300);
  assert.equal(total(mock), n, 'no requests from workers, bulk or timers while paused');
  assert.equal(mock.called('POST', '/reviews').length, 0);
});
await test('secondary limit: message-only 403 escalates 60 -> 120 -> 240 -> 300 (cap)', async ({ page, mock }) => {
  await clockPage(page, mock);
  mock.fail('GET', '/search/issues', 403, SEC);
  await page.locator('#refresh').click(); await slowBanner(page); await page.waitForTimeout(200);
  await expectPause(page, mock, 60, 60); await slowBanner(page); await page.waitForTimeout(200);
  await expectPause(page, mock, 120, 120); await slowBanner(page); await page.waitForTimeout(200);
  await expectPause(page, mock, 240, 240); await slowBanner(page); await page.waitForTimeout(200);
  await expectPause(page, mock, 300, 300);
});
await test('secondary limit: Retry-After 99999 is capped at 5 minutes', async ({ page, mock }) => {
  await clockPage(page, mock);
  mock.fail('GET', '/search/issues', 403, SEC, { 'retry-after': '99999' });
  await page.locator('#refresh').click(); await slowBanner(page); await page.waitForTimeout(200);
  await expectPause(page, mock, 300, 300);
});
await test('secondary limit: Retry-After as HTTP-date is honoured; garbage and negative fall back to 60s', async ({ page, mock }) => {
  await clockPage(page, mock);
  mock.fail('GET', '/search/issues', 403, SEC, { 'retry-after': new Date(Date.now() + 100000).toUTCString() });
  await page.locator('#refresh').click(); await slowBanner(page); await page.waitForTimeout(200);
  await expectPause(page, mock, 98, 100);
});
for (const bad of ['soon', '-5']) {
  await test(`secondary limit: Retry-After "${bad}" is ignored (60s default)`, async ({ page, mock }) => {
    await clockPage(page, mock);
    mock.fail('GET', '/search/issues', 403, SEC, { 'retry-after': bad });
    await page.locator('#refresh').click(); await slowBanner(page); await page.waitForTimeout(200);
    await expectPause(page, mock, 60, 60);
  });
}
await test('secondary limit: a permission 403 is not a secondary limit and does not pause', async ({ page, mock }) => {
  mock.fail('GET', '/search/issues', 403, { message: 'Resource not accessible by personal access token' });
  await page.locator('#refresh').click();
  await page.waitForFunction(() => /403/.test(document.getElementById('banner').textContent));
  assert.doesNotMatch(await txt(page, '#banner'), /slow down/);
  const n = total(mock); await page.locator('#refresh').click(); await page.waitForTimeout(300);
  assert.ok(total(mock) > n, 'next refresh still sends requests');
});
await test('secondary limit: unrelated errors do not replace the pause banner; recovery clears it', async ({ page, mock }) => {
  await clockPage(page, mock);
  mock.fail('GET', '/search/issues', 403, SEC, { 'retry-after': '60' });
  await page.locator('#refresh').click(); await slowBanner(page); await page.waitForTimeout(300);
  const msg = await txt(page, '#banner');
  await page.evaluate(() => { document.getElementById('refresh').click(); });
  await page.waitForTimeout(100);
  assert.equal(await txt(page, '#banner'), msg);
  mock.faults = [];
  await page.clock.runFor(62000);
  await page.waitForFunction(() => !/slow down/.test(document.getElementById('banner').textContent) || document.getElementById('banner').hidden);
});
await test('status cache: unchanged PRs are not refetched; changed updated_at or pending CI are', async ({ page, mock }) => {
  await tab(page, 2); await settled(page); await page.waitForTimeout(500);
  const first = mock.called('GET', '/pulls/\\d+$').length; assert.ok(first > 0);
  mock.calls.length = 0;
  await page.locator('#refresh').click(); await page.waitForTimeout(1500);
  const pending = mock.items.filter((i) => i.pull_request && i.ci === 'pending').length;
  const again = mock.called('GET', '/pulls/\\d+$').filter((c) => !/^\/repos\/acme\/web\/pulls\/11/.test(c.path));
  assert.equal(again.length, 0, 'unchanged PRs not refetched on second refresh (pending CI excepted: ' + pending + ')');
  mock.items.find((i) => i.number === 13).updated_at = new Date().toISOString();
  mock.calls.length = 0;
  await page.locator('#refresh').click(); await page.waitForTimeout(1500);
  const changed = mock.called('GET', '/pulls/\\d+$').map((c) => c.path);
  assert.ok(changed.some((p) => /other\/tools\/pulls\/13/.test(p)), 'changed PR refetched');
  assert.ok(!changed.some((p) => /acme\/api\/pulls\/12/.test(p)), 'unchanged PR still cached');
});
await test('status cache: entries expire after 10 minutes (CI re-runs and base-branch changes do not move updated_at)', async ({ page, mock }) => {
  await page.clock.install(); await page.reload(); await page.locator('#list li').first().waitFor();
  await tab(page, 2); await settled(page); await page.waitForTimeout(500);
  mock.calls.length = 0;
  await page.clock.runFor(6 * 60000); await page.waitForTimeout(800);
  assert.equal(mock.called('GET', 'other/tools/pulls/13$').length, 0, 'cached within the TTL');
  await page.clock.runFor(5 * 60000); await page.waitForTimeout(800);
  assert.ok(mock.called('GET', 'other/tools/pulls/13$').length > 0, 'refetched after the TTL');
});
await test('secondary limit: a write waiting for its 1s slot is not sent once a pause has started', async ({ page, mock }) => {
  await tab(page, 2); await settled(page);
  await page.locator('#list li input[type=checkbox]:not(:disabled)').first().check();
  await page.locator('#bulkall').click(); await page.locator('#bulkapprove').click(); await page.locator('#bulkconfirm').click();
  await until(async () => mock.called('POST', '/reviews').length >= 1, 'first approval');
  mock.fail('GET', '/search/issues', 403, SEC, { 'retry-after': '120' }, 1);
  await page.evaluate(() => document.getElementById('refresh').click()); await slowBanner(page);
  const n = total(mock); await page.waitForTimeout(3000);
  assert.equal(total(mock), n, 'nothing sent after the pause began');
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
await test('detail sync: open panel reloads when the item changes on GitHub, keeping typed text, focus and scroll', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const it = mock.items.find((x) => x.number === 10);
  await page.locator('#detail textarea').fill('draft reply'); await page.locator('#detail textarea').focus();
  await page.evaluate(() => { document.getElementById('detail').scrollTop = 0; });
  it.title = 'Add dark mode v2'; it.comments.push({ user: { login: 'carol' }, created_at: new Date().toISOString(), body: 'fresh news' }); it.updated_at = new Date().toISOString();
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => (await txt(page, '#detail')).includes('fresh news'), 'detail reload');
  assert.match(await txt(page, '#detail'), /Add dark mode v2/);
  assert.match(await txt(page, '#detail'), /Comments \(2\)/);
  assert.equal(await page.locator('#detail textarea').inputValue(), 'draft reply');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#detail textarea')), true);
});
await test('detail sync: unchanged item is not refetched on refresh', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  mock.calls.length = 0;
  await page.locator('#refresh').click(); await settled(page).catch(() => {});
  assert.equal(mock.called('GET', '/issues/10$').length, 0);
});
// ---- detail sync: verification additions ----
const D = '#detail';
const touch = (it, f = {}) => Object.assign(it, f, { updated_at: new Date(Date.now() + 1000 * ++touch.n).toISOString() }); touch.n = 0;
const nGet = (mock, re) => mock.called('GET', re).length;
await test('detail sync: indicator shown, body edit applied, scrollTop and caret preserved, exactly one reload cycle', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const it = mock.items.find((x) => x.number === 10);
  assert.equal(await page.locator('.synced').count(), 0);
  const ta = page.locator(D + ' textarea'); await ta.fill('hello world'); await ta.focus();
  await page.evaluate(() => { const t = document.querySelector('#detail textarea'); t.setSelectionRange(3, 7); });
  const maxTop = await page.evaluate(() => { const d = document.getElementById('detail'); d.scrollTop = 40; return d.scrollHeight - d.clientHeight; });
  mock.calls.length = 0;
  touch(it, { body: 'Edited **body** text' });
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => (await txt(page, D)).includes('Edited body text'), 'body edit');
  assert.equal(await page.locator('.synced').count(), 1);
  assert.match(await txt(page, '.synced'), /Updated on GitHub/);
  assert.equal(await ta.inputValue(), 'hello world');
  assert.deepEqual(await page.evaluate(() => { const t = document.querySelector('#detail textarea'); return [document.activeElement === t, t.selectionStart, t.selectionEnd]; }), [true, 3, 7]);
  if (maxTop >= 40) assert.equal(await page.evaluate(() => document.getElementById('detail').scrollTop), 40);
  await settled(page).catch(() => {}); await page.waitForTimeout(300);
  assert.equal(nGet(mock, '/issues/10$'), 1); assert.equal(nGet(mock, '/issues/10/comments'), 1); assert.equal(nGet(mock, '/pulls/10/files'), 1);
  await page.evaluate(() => document.getElementById('refresh').click()); await page.waitForTimeout(500);
  assert.equal(nGet(mock, '/issues/10$'), 1, 'unchanged item: no further reload');
}, { viewport: { width: 1280, height: 420 } });
await test('detail sync: indicator only appears on in-place updates, not on a normal open', async ({ page }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  assert.equal(await page.locator('.synced').count(), 0);
});
await test('detail sync: CI turning green (updated_at unchanged) updates the open panel without a detail reload', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Draft: refactor router');
  assert.match(await txt(page, D), /build: in_progress/);
  const it = mock.items.find((x) => x.number === 11); it.ci = 'success';
  const ta = page.locator(D + ' textarea'); await ta.fill('wip'); await ta.focus();
  mock.calls.length = 0;
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => (await txt(page, D)).includes('build: success'), 'CI update');
  assert.equal(await page.locator('.synced').count(), 1);
  assert.equal(await ta.inputValue(), 'wip');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#detail textarea')), true);
  assert.equal(nGet(mock, '/issues/11$'), 0, 'no body/comments reload for a CI-only change');
  assert.equal(nGet(mock, '/issues/11/comments'), 0);
});
await test('detail sync: PR closed/merged by someone else keeps the panel with unsent text and gates the actions', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Bump deps');
  const it = mock.items.find((x) => x.number === 13);
  await page.locator(D + ' textarea').fill('still typing');
  touch(it, { state: 'closed' }); it.pull_request = { merged_at: new Date().toISOString() }; // merged: no longer in any open list
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => (await page.locator(D + ' button', { hasText: 'Approve' }).first().isDisabled()), 'actions gated');
  assert.equal(await page.locator(D).isVisible(), true);
  assert.equal(await page.locator(D + ' textarea').inputValue(), 'still typing');
  assert.equal(await page.locator(D + ' button', { hasText: 'Request changes' }).isDisabled(), true);
  assert.equal(await page.locator(D + ' button', { hasText: 'Reopen' }).isDisabled(), true);
  assert.match(await txt(page, D), /merged/);
  const n = nGet(mock, '/issues/13$');
  await page.evaluate(() => document.getElementById('refresh').click()); await page.waitForTimeout(500);
  assert.equal(nGet(mock, '/issues/13$'), n, 'vanished item is reloaded once, not on every refresh');
});
await test('detail sync: closed (not merged) by someone else shows Reopen and no Approve', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Bump deps');
  await page.locator(D + ' textarea').fill('x');
  touch(mock.items.find((x) => x.number === 13), { state: 'closed' });
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => (await page.locator(D + ' button', { hasText: 'Reopen' }).count()) === 1, 'Reopen');
  assert.equal(await page.locator(D + ' button', { hasText: 'Approve' }).isDisabled(), true);
  assert.equal(await page.locator(D + ' button', { hasText: 'Reopen' }).isDisabled(), false);
});
await test('detail sync: item vanishing closes the panel cleanly when nothing is typed', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Bump deps');
  const it = mock.items.find((x) => x.number === 13); touch(it, { state: 'closed' });
  mock.calls.length = 0;
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => !(await page.locator(D).isVisible()), 'panel closed');
  assert.equal(await page.locator('#list li.selected, #list li[aria-selected=true]').count(), 0);
  assert.equal(nGet(mock, '/issues/13$'), 0);
});
await test('detail sync: hostile body/comment text stays inert after a background reload; CSP intact', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const it = mock.items.find((x) => x.number === 10);
  touch(it, { body: '<img src=x onerror="window.__xss=9"><script>window.__xss=8</script>[j](javascript:window.__xss=7)' });
  it.comments.push({ user: { login: 'eve<b>' }, created_at: new Date().toISOString(), body: '<img src=x onerror="window.__xss=6"> ![e](https://evil.example/t.png)' });
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => (await txt(page, D)).includes('Comments (2)'), 'reload');
  assert.deepEqual(await page.evaluate(() => ({ x: window.__xss ?? null, bad: document.querySelectorAll('#detail [onerror], #detail script, #detail img[src*="evil"], #detail a[href^="javascript"]').length, csp: window.__csp })), { x: null, bad: 0, csp: [] });
});
await test('detail sync: nothing is sent during a rate-limit pause; a failing background reload leaves the panel intact', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const it = mock.items.find((x) => x.number === 10);
  await page.locator(D + ' textarea').fill('keep me');
  touch(it, { body: 'Changed while paused' });
  mock.fail('GET', '/issues/10$', 403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '120' }, 1);
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => (await txt(page, '#banner')).includes('slow down'), 'pause banner');
  assert.equal(await page.locator(D + ' textarea').inputValue(), 'keep me');
  assert.equal(await page.locator(D).isVisible(), true);
  mock.calls.length = 0;
  await page.evaluate(() => document.getElementById('refresh').click()); await page.waitForTimeout(600);
  assert.equal(mock.calls.length, 0, 'zero requests while paused');
});
await test('detail sync: skipped while an action is in progress, then the action refreshes the panel once', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const it = mock.items.find((x) => x.number === 10);
  let release; const gate = new Promise((r) => { release = r; });
  let posted = 0;
  await page.route(/\/issues\/10\/comments$/, async (route) => { if (route.request().method() === 'POST') { posted++; await gate; } await route.fallback(); });
  await page.locator(D + ' textarea').fill('my comment');
  await page.locator(D + ' button', { hasText: 'Comment' }).click();
  await until(async () => posted === 1, 'POST sent');
  touch(it, { body: 'Changed mid-action' }); mock.calls.length = 0;
  await page.evaluate(() => document.getElementById('refresh').click()); await page.waitForTimeout(600);
  assert.equal(nGet(mock, '/issues/10$'), 0, 'no detail reload while busy');
  assert.equal(await page.locator(D + ' button', { hasText: 'Comment' }).isDisabled(), true, 'action buttons untouched');
  release();
  await until(async () => (await txt(page, D)).includes('Changed mid-action'), 'post-action reload');
});
await test('detail sync: not re-rendered behind an open bulk dialog; syncs after it closes', async ({ page, mock }) => {
  await tab(page, 2); await settled(page); await open_(page, 'Add dark mode');
  await page.locator('#list li input[type=checkbox]:not(:disabled)').first().check();
  await page.locator('#bulkapprove').click(); await page.locator('#bulkcancel').waitFor();
  touch(mock.items.find((x) => x.number === 10), { body: 'Changed behind dialog' }); mock.calls.length = 0;
  await page.evaluate(() => document.getElementById('refresh').click()); await page.waitForTimeout(700);
  assert.equal(nGet(mock, '/issues/10$'), 0);
  assert.doesNotMatch(await txt(page, D), /Changed behind dialog/);
  await page.locator('#bulkcancel').click();
  await until(async () => (await txt(page, D)).includes('Changed behind dialog'), 'sync after dialog closes');
  assert.equal(nGet(mock, '/issues/10$'), 1);
});
await test('detail sync: race - selecting another item while a background reload is in flight keeps the new item', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const it = mock.items.find((x) => x.number === 10);
  let release; const gate = new Promise((r) => { release = r; }); let held = 0;
  await page.route(/\/repos\/acme\/web\/issues\/10$/, async (route) => { held++; await gate; await route.fallback(); });
  touch(it, { body: 'A changed' });
  await page.evaluate(() => document.getElementById('refresh').click());
  await until(async () => held === 1, 'A reload in flight');
  await row(page, 'Bump deps').click();
  await page.locator(D + ' h3', { hasText: 'other/tools#13' }).waitFor();
  release(); await page.waitForTimeout(800);
  assert.match(await txt(page, D), /other\/tools#13/);
  assert.doesNotMatch(await txt(page, D), /A changed|acme\/web#10/);
  assert.equal(await page.locator('.synced').count(), 0);
});
await test('detail sync: back-to-back refreshes do not overlap reloads; the latest change still wins', async ({ page, mock }) => {
  await tab(page, 2); await open_(page, 'Add dark mode');
  const it = mock.items.find((x) => x.number === 10);
  let release; const gate = new Promise((r) => { release = r; }); let held = 0;
  await page.route(/\/repos\/acme\/web\/issues\/10$/, async (route) => { held++; if (held === 1) await gate; await route.fallback(); });
  touch(it, { body: 'first edit' });
  await page.evaluate(() => document.getElementById('refresh').click()); await until(async () => held === 1, 'first reload in flight');
  touch(it, { body: 'second edit' });
  await page.evaluate(() => document.getElementById('refresh').click()); await page.waitForTimeout(600);
  assert.equal(held, 1, 'no overlapping reload while one is in flight');
  release();
  await until(async () => (await txt(page, D)).includes('second edit'), 'latest wins');
  await page.waitForTimeout(400);
  assert.equal(held, 2);
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
  for (let n = 0; n < 40 && mock.called('PATCH', '/issues/20').length < 2; n++) await new Promise((r) => setTimeout(r, 100));
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
await test('CSP: policy present; inline script, foreign fetch and foreign image are blocked', async ({ page }) => {
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
  const csp = await page.evaluate(() => window.__csp);
  assert.ok(csp.length >= 3, 'CSP violations reported: ' + csp.length);
});
await test('token check (signed in): all permissions ok, read-only calls, no token leak', async ({ page, mock }) => {
  await settled(page); mock.calls.length = 0;
  await page.locator('#checktoken').click();
  await page.locator('#tokencheck .chk-ok').first().waitFor();
  const t = await txt(page, '#tokencheck');
  for (const l of ['Authenticate', 'Search', 'Pull requests: Read', 'Checks: Read', 'Commit statuses: Read', 'Issues: Read', 'Contents: Read', 'Contents: Write']) assert.ok(t.includes(l), l);
  assert.equal(await page.locator('#tokencheck .chk-missing, #tokencheck .chk-error').count(), 0);
  assert.equal(await page.locator('#tokencheck .chk-unverifiable').count(), 1);
  assert.ok(t.includes('Cannot verify - needed only to merge'));
  assert.ok(mock.calls.length > 5 && mock.calls.every((c) => c.method === 'GET'), 'only GET calls');
  assert.ok(!t.includes('tok') || !/\btok\b/.test(t));
});
await test('token check (sign-in screen): token missing Checks is reported by name', async ({ page, mock }) => {
  mock.fail('GET', 'check-runs', 403, { message: 'Resource not accessible' });
  await page.locator('#token').fill('tok'); await page.locator('#checklogin').click();
  await page.locator('#tokencheck .chk-missing').waitFor();
  assert.equal(await txt(page, '#tokencheck .chk-missing'), '✗ missing Checks: Read — Checks: Read');
  assert.equal(await page.locator('#tokencheck .chk-missing').count(), 1);
  assert.equal(await page.locator('#token').inputValue(), 'tok');
  assert.ok(await page.locator('#login').isVisible(), 'still signed out');
}, { token: null });
await test('token check runs once automatically after sign-in; brief OK note, not on refresh', async ({ page, mock }) => {
  await page.locator('#token').fill('tok'); await page.locator('#loginform button[type=submit]').click();
  await page.locator('#tokencheck', { hasText: 'Token OK' }).waitFor();
  assert.equal(await page.locator('#tokencheck li').count(), 0);
  const n = () => mock.called('GET', '/contents/').length;
  assert.equal(n(), 1);
  await page.locator('#refresh').click(); await settled(page);
  assert.equal(n(), 1, 'no re-check on refresh');
}, { token: null });
await test('token check after sign-in lists missing permission automatically', async ({ page, mock }) => {
  mock.fail('GET', 'check-runs', 403, { message: 'nope' });
  await page.locator('#token').fill('tok'); await page.locator('#loginform button[type=submit]').click();
  await page.locator('#tokencheck .chk-missing').waitFor();
  assert.ok((await txt(page, '#tokencheck .chk-missing')).includes('Checks: Read'));
}, { token: null });
const nContents = (mock) => mock.called('GET', '/contents/').length;
await test('token check: saved-token load checks once per session per token, silently, not on later loads', async ({ page, mock }) => {
  await settled(page);
  await until(async () => nContents(mock) === 1, 'one automatic check');
  assert.equal(await page.locator('#tokencheck').isVisible(), false, 'silent when all is well');
  assert.equal(mock.called('GET', '^/user$').length, 1, 'check reuses the cached /user');
  const searches = mock.called('GET', '/search/issues').length;
  assert.ok(searches <= 5 + 1, 'at most one search beyond refresh: ' + searches);
  assert.ok(mock.calls.every((c) => c.method === 'GET'), 'only GETs');
  const key = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('gh_dashboard_tokencheck_')));
  assert.equal(key.length, 1); assert.ok(!key[0].includes('tok') || key[0].length > 30);
  assert.ok(!(await page.evaluate(() => JSON.stringify([...Object.values(sessionStorage)]))).includes('"tok"'));
  for (let k = 0; k < 2; k++) { await page.reload(); await settled(page); }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(nContents(mock), 1, 'two reloads: no further automatic check');
  assert.equal(mock.called('GET', '^/user$').length, 3, 'only the page\'s own /user per load');
});
await test('token check: automatic warning shows once per session; manual check always runs the full probe', async ({ page, mock }) => {
  await settled(page);
  await until(async () => nContents(mock) === 1, 'first check');
  await page.evaluate(() => sessionStorage.clear());
  mock.fail('GET', 'check-runs', 403, { message: 'nope' });
  await page.reload(); await settled(page);
  await page.locator('#tokencheck .chk-missing').waitFor();
  assert.equal(nContents(mock), 2);
  await page.reload(); await settled(page); await new Promise((r) => setTimeout(r, 300));
  assert.equal(nContents(mock), 2, 'no automatic check on the next load');
  assert.equal(await page.locator('#tokencheck').isVisible(), false);
  const u = mock.called('GET', '^/user$').length;
  await page.locator('#checktoken').click(); await page.locator('#tokencheck .chk-missing').waitFor();
  assert.equal(nContents(mock), 3);
  assert.equal(mock.called('GET', '^/user$').length, u + 1, 'manual run probes /user itself');
  await page.locator('#checktoken').click(); await until(async () => nContents(mock) === 4, 'manual run again');
});
await test('token check: skipped while rate-limited (also guards bulk batches), and not marked as done', async ({ page, mock }) => {
  await settled(page); await until(async () => nContents(mock) === 1, 'first check');
  await page.evaluate(() => sessionStorage.clear());
  mock.fail('GET', '/search/issues', 403, { message: 'rate' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
  await page.reload(); await settled(page); await new Promise((r) => setTimeout(r, 400));
  assert.equal(nContents(mock), 1, 'no check while rate-limited');
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('gh_dashboard_tokencheck_')).length), 0);
});
await test('token check: 401 on manual check shows "Token rejected"', async ({ page, mock }) => {
  await settled(page);
  mock.fail('GET', '^/user$', 401, { message: 'Bad credentials' });
  await page.locator('#checktoken').click();
  await page.locator('#tokencheck', { hasText: 'Token rejected (401)' }).waitFor();
  assert.equal(await page.locator('#tokencheck .chk-error').count(), 1);
});
await test('token check: missing permission rendering names the permission and no literal null/undefined', async ({ page, mock }) => {
  await settled(page);
  mock.fail('GET', '/commits/.*/status$', 403, { message: 'nope' }); mock.fail('GET', '/issues/\\d+$', 403, { message: 'nope' });
  await page.locator('#checktoken').click(); await page.locator('#tokencheck .chk-missing').first().waitFor();
  const t = await txt(page, '#tokencheck');
  assert.ok(t.includes('Issues: Read') && /Commit statuses: Read/.test(t));
  assert.equal(await page.locator('#tokencheck .chk-missing').count(), 2);
  assert.ok(!/\b(null|undefined|false)\b/.test(t));
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
