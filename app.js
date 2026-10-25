const API = 'https://api.github.com';
const TOKEN_KEY = 'gh_dashboard_token';
const REPO_KEY = 'gh_dashboard_repo';
const TAB_KEY = 'gh_dashboard_tab';
const AUTO_KEY = 'gh_dashboard_autorefresh';
const AUTO_CHOICES = [0, 2, 5, 10]; // minutes; 0 = off

const TABS = [
  { id: 'authored', label: 'My PRs', pr: true, queries: ['is:pr is:open author:@me'] },
  { id: 'review', label: 'Review requested', pr: true, queries: ['is:pr is:open review-requested:@me'] },
  { id: 'involved', label: 'Assigned / mentioned PRs', pr: true, queries: ['is:pr is:open assignee:@me', 'is:pr is:open mentions:@me'] },
  { id: 'assigned', label: 'Issues assigned', pr: false, queries: ['is:issue is:open assignee:@me'] },
  { id: 'created', label: 'Issues created', pr: false, queries: ['is:issue is:open author:@me'] },
];

const state = { repo: localStorage.getItem(REPO_KEY) || '', token: null, tab: TABS.some((t) => t.id === localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : TABS[0].id, data: {}, selected: null, status: new Map(), autoMin: loadAuto(), lastUpdated: 0, lastAttempt: 0, rateLimitUntil: 0, busy: 0, refreshing: false, timer: null };
function loadAuto() {
  const v = localStorage.getItem(AUTO_KEY);
  return v !== null && AUTO_CHOICES.includes(Number(v)) ? Number(v) : 5;
}
const $ = (id) => document.getElementById(id);

// DOM helper: all text goes through textContent / text nodes, never innerHTML.
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const clear = (n) => n.replaceChildren();

function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'github.com' ? x.href : null; } catch { return null; }
}

function banner(msg, info = false) {
  const b = $('banner');
  b.textContent = msg || '';
  b.hidden = !msg;
  b.className = info ? 'info' : '';
}

class ApiError extends Error {}

async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + state.token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.ok) return res.status === 204 ? null : res.json();
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
  if (res.status === 401) {
    signOut();
    throw new ApiError('Token rejected (401). Please sign in again.');
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    state.rateLimitUntil = reset || Date.now() + 60000;
    throw new ApiError('Rate limit exceeded. Resets at ' + new Date(reset).toLocaleTimeString() + '.');
  }
  throw new ApiError(`GitHub API error ${res.status}${msg ? ': ' + msg : ''}`);
}

async function paged(path, max = 100) {
  const sep = path.includes('?') ? '&' : '?';
  return gh(`${path}${sep}per_page=${max}`);
}

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  for (const [n, u] of [[86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return Math.floor(s / n) + u;
  return 'now';
}
const repoOf = (i) => i.repository_url.split('/').slice(-2).join('/');

// ---- auth ----
function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null; state.data = {}; state.selected = null; state.status.clear(); state.lastUpdated = 0; state.lastAttempt = 0; state.rateLimitUntil = 0;
  renderUpdated(); showView(); scheduleAuto();
}
function showView() {
  const on = !!state.token;
  $('login').hidden = on; $('dash').hidden = !on; $('userbox').hidden = !on;
}
$('loginform').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('token').value.trim();
  $('token').value = '';
  try {
    const me = await gh('/user');
    localStorage.setItem(TOKEN_KEY, state.token);
    $('username').textContent = me.login;
    banner('');
    showView(); refresh();
  } catch (err) {
    state.token = null;
    banner(err.message);
  }
});
$('signout').addEventListener('click', signOut);
$('refresh').addEventListener('click', () => refresh());
$('textfilter').addEventListener('input', renderList);
$('repofilter').addEventListener('change', () => {
  state.repo = $('repofilter').value;
  if (state.repo) localStorage.setItem(REPO_KEY, state.repo); else localStorage.removeItem(REPO_KEY);
  renderList();
});

// ---- lists ----
async function loadTab(tab) {
  const seen = new Map();
  for (const q of tab.queries) {
    const r = await gh('/search/issues?per_page=50&sort=updated&q=' + encodeURIComponent(q));
    for (const i of r.items) seen.set(i.id, i);
  }
  return [...seen.values()].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

// auto = true for timer-driven refreshes: keep old data/statuses on failure and keep scroll positions (no flicker).
async function refresh(auto = false) {
  if (!state.token) return;
  if (auto === true && state.refreshing) return;
  if (auto !== true) { banner(''); state.status.clear(); }
  state.refreshing = true;
  $('refresh').disabled = true;
  const token = state.token;
  let results;
  try {
    results = await Promise.all(TABS.map((t) => loadTab(t).catch((e) => { banner(e.message); return auto === true ? null : []; })));
  } finally { $('refresh').disabled = false; state.refreshing = false; }
  if (state.token !== token) return; // signed out meanwhile
  TABS.forEach((t, i) => { if (results[i]) state.data[t.id] = results[i]; });
  state.lastAttempt = Date.now();
  if (results.some(Boolean)) state.lastUpdated = state.lastAttempt;
  const detail = $('detail'), y = window.scrollY, dy = detail.scrollTop;
  renderTabs(); renderRepos(); renderList(); renderUpdated();
  window.scrollTo(window.scrollX, y); detail.scrollTop = dy;
  scheduleAuto();
  loadPrStatuses();
}

// ---- auto refresh ----
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
function renderUpdated() { $('lastupdated').textContent = state.lastUpdated ? 'Last updated ' + fmtTime(state.lastUpdated) : ''; }
const autoBlocked = () => state.refreshing || state.busy > 0 || Date.now() < state.rateLimitUntil;
function scheduleAuto() {
  clearTimeout(state.timer); state.timer = null;
  if (!state.token || !state.autoMin || document.visibilityState !== 'visible') return;
  const due = Math.max(state.lastUpdated, state.lastAttempt) + state.autoMin * 60000;
  const wait = Math.max(due - Date.now(), state.rateLimitUntil - Date.now(), state.busy || state.refreshing ? 5000 : 0, 1000);
  state.timer = setTimeout(() => {
    state.timer = null;
    if (autoBlocked() || Date.now() < due) scheduleAuto(); else refresh(true);
  }, wait);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { clearTimeout(state.timer); state.timer = null; return; }
  if (state.token && state.autoMin && !autoBlocked() && Date.now() - state.lastUpdated >= state.autoMin * 60000) refresh(true);
  else scheduleAuto();
});
$('autorefresh').value = String(state.autoMin);
$('autorefresh').addEventListener('change', () => {
  state.autoMin = Number($('autorefresh').value);
  localStorage.setItem(AUTO_KEY, String(state.autoMin));
  scheduleAuto();
});

function renderTabs() {
  const nav = $('tabs'); clear(nav);
  for (const t of TABS) {
    nav.append(h('button', {
      role: 'tab', type: 'button', 'aria-selected': String(t.id === state.tab),
      onclick: () => { state.tab = t.id; localStorage.setItem(TAB_KEY, t.id); state.selected = null; closeDetail(); renderTabs(); renderRepos(); renderList(); },
    }, t.label, h('span', { class: 'count' }, (state.data[t.id] || []).length)));
  }
}

function renderRepos() {
  const sel = $('repofilter');
  const repos = [...new Set((state.data[state.tab] || []).map(repoOf))].sort();
  clear(sel);
  sel.append(h('option', { value: '' }, 'All repos'), ...repos.map((r) => h('option', { value: r }, r)));
  sel.value = repos.includes(state.repo) ? state.repo : '';
}

function renderList() {
  const ul = $('list'); clear(ul);
  const q = $('textfilter').value.toLowerCase(), repo = $('repofilter').value;
  const items = (state.data[state.tab] || []).filter((i) =>
    (!repo || repoOf(i) === repo) && (!q || (i.title + ' ' + repoOf(i) + ' ' + i.number).toLowerCase().includes(q)));
  if (!items.length) { ul.append(h('li', { class: 'empty' }, 'Nothing here.')); return; }
  for (const i of items) {
    const st = state.status.get(i.id);
    const link = safeUrl(i.html_url);
    ul.append(h('li', { class: state.selected === i.id ? 'sel' : '', tabindex: '0', onclick: () => select(i), onkeydown: (e) => { if (e.key === 'Enter') select(i); } },
      h('div', { class: 'row-title' }, i.title),
      h('div', { class: 'meta' },
        h('span', {}, `${repoOf(i)}#${i.number}`),
        ...i.labels.map((l) => h('span', { class: 'label' }, l.name)),
        h('span', {}, 'updated ' + ago(i.updated_at) + ' ago · opened ' + ago(i.created_at) + ' ago'),
        i.pull_request && st ? h('span', { class: 'st-' + st.ci }, 'CI: ' + st.ci) : null,
        i.pull_request && st ? h('span', { class: 'st-' + st.review }, 'Review: ' + st.review) : null,
        link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'GitHub ↗') : null)));
  }
}

// ---- PR status (CI + review), fetched lazily with limited concurrency ----
function ciOf(checks, combined) {
  const runs = checks.check_runs || [];
  const states = runs.map((r) => (r.status !== 'completed' ? 'pending'
    : ['success', 'neutral', 'skipped'].includes(r.conclusion) ? 'success' : 'failure'));
  if (combined.total_count > 0) states.push(combined.state === 'success' ? 'success' : combined.state === 'pending' ? 'pending' : 'failure');
  if (!states.length) return 'none';
  return states.includes('failure') ? 'failure' : states.includes('pending') ? 'pending' : 'success';
}
function reviewOf(reviews) {
  const latest = new Map();
  for (const r of reviews) if (r.state !== 'COMMENTED' && r.state !== 'PENDING' && r.user) latest.set(r.user.login, r.state);
  const v = [...latest.values()];
  return v.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : v.includes('APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
}
async function prStatus(i) {
  const [owner, repo] = repoOf(i).split('/');
  const base = `/repos/${owner}/${repo}`;
  const pr = await gh(`${base}/pulls/${i.number}`);
  const [checks, combined, reviews] = await Promise.all([
    gh(`${base}/commits/${pr.head.sha}/check-runs?per_page=100`),
    gh(`${base}/commits/${pr.head.sha}/status`),
    paged(`${base}/pulls/${i.number}/reviews`),
  ]);
  return { ci: ciOf(checks, combined), review: reviewOf(reviews), pr, checks, combined, reviews };
}
async function loadPrStatuses() {
  const prs = [...new Map(TABS.filter((t) => t.pr).flatMap((t) => state.data[t.id] || []).map((i) => [i.id, i])).values()];
  let idx = 0;
  async function worker() {
    while (idx < prs.length) {
      const i = prs[idx++];
      try { state.status.set(i.id, await prStatus(i)); renderList(); }
      catch (e) { banner(e.message); idx = prs.length; }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ---- detail ----
function closeDetail() { $('detail').hidden = true; $('layout').classList.remove('open'); }

async function select(i) {
  state.selected = i.id;
  renderList();
  const d = $('detail'); clear(d);
  d.hidden = false; $('layout').classList.add('open');
  d.append(h('p', {}, 'Loading…'));
  try {
    const [owner, repo] = repoOf(i).split('/');
    const base = `/repos/${owner}/${repo}`;
    const isPr = !!i.pull_request;
    const [full, comments, files, st] = await Promise.all([
      gh(`${base}/issues/${i.number}`),
      paged(`${base}/issues/${i.number}/comments`),
      isPr ? paged(`${base}/pulls/${i.number}/files`, 100) : [],
      isPr ? prStatus(i) : null,
    ]);
    if (st) state.status.set(i.id, st);
    if (state.selected !== i.id) return;
    renderDetail(i, base, full, comments, files, st);
  } catch (e) { banner(e.message); closeDetail(); }
}

function renderDetail(i, base, full, comments, files, st) {
  const d = $('detail'); clear(d);
  const isPr = !!i.pull_request;
  const link = safeUrl(full.html_url);
  d.append(
    h('h3', {}, `${repoOf(i)}#${i.number}: ${full.title}`),
    h('div', { class: 'meta' }, h('span', {}, 'by ' + (full.user ? full.user.login : 'unknown')), h('span', {}, 'state: ' + full.state),
      link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open on GitHub ↗') : null,
      h('button', { type: 'button', onclick: () => { closeDetail(); state.selected = null; renderList(); } }, 'Close')),
    h('div', { class: 'body' }, full.body || '(no description)'));

  if (isPr && st) {
    d.append(h('h3', {}, 'Status'),
      h('div', { class: 'meta' },
        h('span', { class: 'st-' + st.ci }, 'CI: ' + st.ci),
        h('span', { class: 'st-' + st.review }, 'Review: ' + st.review),
        h('span', {}, 'mergeable: ' + (st.pr.mergeable_state || 'unknown'))),
      h('ul', {}, ...(st.checks.check_runs || []).map((r) => h('li', {}, `${r.name}: ${r.status === 'completed' ? r.conclusion : r.status}`))));
    d.append(h('h3', {}, `Changed files (${files.length}${files.length >= 100 ? '+' : ''})`),
      h('ul', { class: 'files' }, ...files.map((f) => h('li', {}, `${f.filename} (+${f.additions} −${f.deletions})`))));
  }

  d.append(h('h3', {}, `Comments (${comments.length})`),
    ...comments.map((c) => h('div', { class: 'comment' },
      h('div', { class: 'meta' }, (c.user ? c.user.login : 'unknown') + ' · ' + ago(c.created_at) + ' ago'),
      h('div', { class: 'body' }, c.body))));

  const ta = h('textarea', { placeholder: 'Comment (optional for approve)' });
  const btns = [];
  const act = (label, fn, cls = '') => {
    const b = h('button', { type: 'button', class: cls, onclick: async () => {
      btns.forEach((x) => { x.disabled = true; });
      state.busy++;
      let held = true;
      const release = () => { if (held) { held = false; state.busy--; } };
      try { await fn(); banner(label + ': done', true); release(); await refresh(); if (state.selected === i.id) select(i); }
      catch (e) { banner(e.message); btns.forEach((x) => { x.disabled = false; }); }
      finally { release(); scheduleAuto(); }
    } }, label);
    btns.push(b); return b;
  };
  const text = () => ta.value.trim();
  const needText = () => { if (!text()) throw new ApiError('Enter a comment first.'); return text(); };
  const review = (event) => gh(`${base}/pulls/${i.number}/reviews`, { method: 'POST', body: { event, ...(text() ? { body: text() } : {}) } });
  const comment = act('Comment', () => gh(`${base}/issues/${i.number}/comments`, { method: 'POST', body: { body: needText() } }));
  const row = h('div', { class: 'actions' }, comment);
  if (isPr) {
    row.append(
      act('Approve', () => review('APPROVE'), 'primary'),
      act('Request changes', () => { needText(); return review('REQUEST_CHANGES'); }, 'danger'),
      act('Merge', async () => {
        if (!confirm(`Merge ${repoOf(i)}#${i.number}?\n\n${full.title}`)) throw new ApiError('Merge cancelled.');
        await gh(`${base}/pulls/${i.number}/merge`, { method: 'PUT', body: { merge_method: 'merge' } });
      }, 'danger'));
  }
  const closed = full.state === 'closed';
  row.append(act(closed ? 'Reopen' : 'Close', () => gh(`${base}/issues/${i.number}`, { method: 'PATCH', body: { state: closed ? 'open' : 'closed' } }), isPr ? 'danger' : ''));
  d.append(h('h3', {}, 'Actions'), ta, row);
}

// ---- init ----
state.token = localStorage.getItem(TOKEN_KEY);
showView();
if (state.token) {
  gh('/user').then((me) => { $('username').textContent = me.login; refresh(); }).catch((e) => banner(e.message));
}
