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

const state = { repo: localStorage.getItem(REPO_KEY) || '', token: null, tab: TABS.some((t) => t.id === localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : TABS[0].id, data: {}, selected: null, cursor: null, sel: new Set(), status: new Map(), autoMin: loadAuto(), lastUpdated: 0, lastAttempt: 0, rateLimitUntil: 0, busy: 0, refreshing: false, timer: null };
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

class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

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
  try {
    const j = await res.json();
    msg = j.message || '';
    if (Array.isArray(j.errors) && j.errors.length) {
      const det = j.errors.map((x) => typeof x === 'string' ? x
        : x && typeof x === 'object' ? [x.message, x.resource, x.field, x.code].filter(Boolean).join(' ') : String(x)).filter(Boolean).join('; ');
      if (det) msg += (msg ? ' — ' : '') + det;
    }
  } catch { /* ignore */ }
  if (res.status === 401) {
    signOut();
    throw new ApiError('Token rejected (401). Please sign in again.', 401);
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    state.rateLimitUntil = reset || Date.now() + 60000;
    throw new ApiError('Rate limit exceeded. Resets at ' + new Date(reset).toLocaleTimeString() + '.', 429);
  }
  throw new ApiError(`GitHub API error ${res.status}${msg ? ': ' + msg : ''}`, res.status);
}

async function getMe() {
  if (state.me) return state.me;
  const token = state.token;
  const me = (await gh('/user')).login;
  if (state.token === token) state.me = me;
  return me;
}

// ---- markdown (no libraries; builds DOM nodes only, never innerHTML) ----
function safeLink(u) {
  try { const x = new URL(u); return ['http:', 'https:', 'mailto:'].includes(x.protocol) ? x.href : null; } catch { return null; }
}
function safeImg(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' || x.username || x.password || x.port) return null;
    const host = x.hostname.toLowerCase();
    return host === 'github.com' || host === 'github.githubassets.com' || host.endsWith('.githubusercontent.com') ? x.href : null;
  } catch { return null; }
}
const mdLink = (href, kids) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, kids);

function mdInline(s, depth = 0) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const sub = (t) => (depth > 6 ? [t] : mdInline(t, depth + 1));
  const next = /[\\`*_~\[!<\n]|https?:\/\//g;
  const sticky = (re, i) => { re.lastIndex = i; return re.exec(s); };
  const R = {
    code: /(`+)([\s\S]*?[^`])\1(?!`)/y,
    img: /!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/y,
    link: /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/y,
    auto: /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y,
    bare: /https?:\/\/[^\s<>"]+/y,
    comment: /<!--[\s\S]*?-->/y,
    bold: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y,
    strike: /~~(?=\S)([\s\S]*?\S)~~/y,
    ital: /(\*|_)(?=\S)([\s\S]*?\S)\1/y,
  };
  let i = 0;
  while (i < s.length) {
    next.lastIndex = i;
    const f = next.exec(s);
    if (!f) { buf += s.slice(i); break; }
    buf += s.slice(i, f.index);
    i = f.index;
    const c = s[i];
    let m;
    const prevWord = i > 0 && /\w/.test(s[i - 1]);
    if (c === '\n') { flush(); out.push(h('br')); i++; continue; }
    if (c === '\\' && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`' && (m = sticky(R.code, i))) { flush(); out.push(h('code', {}, m[2].replace(/^ (.*) $/s, '$1'))); i += m[0].length; continue; }
    if (c === '!' && s[i + 1] === '[' && (m = sticky(R.img, i))) {
      flush();
      const href = safeLink(m[2]);
      const alt = m[1] || m[2];
      const label = '🖼 ' + alt;
      const src = safeImg(m[2]);
      if (src) {
        const img = h('img', { src, alt, loading: 'lazy', referrerpolicy: 'no-referrer', class: 'md-img' });
        img.addEventListener('error', () => { img.replaceWith(h('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, label)); }, { once: true });
        out.push(img);
      } else out.push(href ? mdLink(href, label) : label);
      i += m[0].length; continue;
    }
    if (c === '[' && (m = sticky(R.link, i))) {
      flush();
      const href = safeLink(m[2]);
      out.push(href ? mdLink(href, sub(m[1])) : sub(m[1])); i += m[0].length; continue;
    }
    if (c === '<') {
      if ((m = sticky(R.comment, i))) { flush(); i += m[0].length; continue; }
      if ((m = sticky(R.auto, i))) { flush(); const href = safeLink(m[1]); out.push(href ? mdLink(href, m[1]) : m[0]); i += m[0].length; continue; }
    }
    if (c === 'h' && !prevWord && (m = sticky(R.bare, i))) {
      let u = m[0];
      while (/[.,;:!?)\]'*_~]$/.test(u)) u = u.slice(0, -1);
      const href = safeLink(u);
      if (href) { flush(); out.push(mdLink(href, u)); i += u.length; continue; }
    }
    if (c === '*' || c === '_') {
      if (!(c === '_' && prevWord) && s[i + 1] === c && (m = sticky(R.bold, i)) && m[1] === c + c) { flush(); out.push(h('strong', {}, sub(m[2]))); i += m[0].length; continue; }
      if (!(c === '_' && prevWord) && (m = sticky(R.ital, i)) && m[1] === c && !/\w/.test(c === '_' ? (s[i + m[0].length] || ' ') : ' ')) { flush(); out.push(h('em', {}, sub(m[2]))); i += m[0].length; continue; }
    }
    if (c === '~' && s[i + 1] === '~' && (m = sticky(R.strike, i))) { flush(); out.push(h('del', {}, sub(m[1]))); i += m[0].length; continue; }
    buf += c; i++;
    if (c === 'h' || f[0].length > 1) { buf += f[0].slice(1); i += f[0].length - 1; }
  }
  flush();
  return out;
}

const MD_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const MD_HR = /^ {0,3}([-*_])( *\1){2,} *$/;
const MD_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MD_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const mdCells = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, '|'));
};
const mdStartsBlock = (l, nl) => MD_FENCE.test(l) || /^ {0,3}#{1,6}\s/.test(l) || MD_HR.test(l) || /^ {0,3}>/.test(l)
  || /^\s*([-*+]|1[.)])[ \t]+\S/.test(l) || /^\s*<!--/.test(l) || (l.includes('|') && nl != null && l.trim() !== '' && MD_DELIM.test(nl) && nl.includes('-') && (nl.includes('|') || mdCells(l).length > 1));

function mdBlocks(lines, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = MD_FENCE.exec(line)) && !(m[1][0] === '`' && m[2].includes('`'))) {
      const fence = m[1]; const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence) && /^[`~]+\s*$/.test(lines[i].trim()) && lines[i].trim().length >= fence.length)) body.push(lines[i++]);
      i++;
      out.push(h('pre', { class: 'md-pre' }, h('code', {}, body.join('\n'))));
      continue;
    }
    if (/^\s*<!--/.test(line) && !/-->\s*\S/.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
      continue;
    }
    if ((m = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line))) {
      out.push(h('h' + Math.min(m[1].length + 2, 6), { class: 'md-h' }, mdInline(m[2])));
      i++; continue;
    }
    if (MD_HR.test(line)) { out.push(h('hr')); i++; continue; }
    if (/^ {0,3}>/.test(line) && depth < 8) {
      const q = [];
      while (i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || (q.length && !mdStartsBlock(lines[i])))) q.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out.push(h('blockquote', {}, mdBlocks(q, depth + 1)));
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && MD_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-') && (lines[i + 1].includes('|') || mdCells(line).length > 1)) {
      const head = mdCells(line);
      const al = mdCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(mdCells(lines[i++]));
      const cell = (tag, t, k) => h(tag, al[k] ? { class: 'md-' + al[k] } : {}, mdInline(t));
      out.push(h('div', { class: 'md-table' }, h('table', {},
        h('thead', {}, h('tr', {}, head.map((t, k) => cell('th', t, k)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, head.map((_, k) => cell('td', r[k] || '', k))))))));
      continue;
    }
    if ((m = MD_ITEM.exec(line)) && depth < 8) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const items = [];
      let cur = null;
      while (i < lines.length) {
        const l = lines[i];
        const im = MD_ITEM.exec(l);
        if (im && im[1].length <= base + 1 && !MD_HR.test(l)) {
          if (/\d/.test(im[2]) !== ordered && items.length) break;
          cur = { first: im[3], rest: [], indent: im[1].length + im[2].length + 1 }; items.push(cur); i++; continue;
        }
        if (!l.trim()) {
          let j = i; while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && (/^\s{2,}\S/.test(lines[j]) && lines[j].search(/\S/) > base || (MD_ITEM.exec(lines[j]) && MD_ITEM.exec(lines[j])[1].length <= base + 1 && /\d/.test(MD_ITEM.exec(lines[j])[2]) === ordered))) {
            for (; i < j; i++) cur.rest.push('');
            continue;
          }
          break;
        }
        if (l.search(/\S/) > base || !mdStartsBlock(l)) { cur.rest.push(l.slice(Math.min(l.search(/\S/), cur.indent))); i++; continue; }
        break;
      }
      const lis = items.map((it) => {
        let first = it.first; let box = null;
        const tm = /^\[([ xX])\][ \t]+(.*)$/.exec(first);
        if (tm) { box = h('input', { type: 'checkbox', disabled: true, checked: tm[1] !== ' ', 'aria-label': tm[1] === ' ' ? 'not done' : 'done' }); first = tm[2]; }
        const kids = mdBlocks([first, ...it.rest], depth + 1);
        if (box) { if (kids[0] && kids[0].tagName === 'P') kids[0].prepend(box, ' '); else kids.unshift(box); }
        return h('li', box ? { class: 'task' } : {}, kids);
      });
      const start = ordered ? parseInt(m[2], 10) : null;
      out.push(h(ordered ? 'ol' : 'ul', ordered && start !== 1 ? { start: String(start) } : {}, lis));
      continue;
    }
    const para = [line.replace(/^ +/, '')];
    i++;
    while (i < lines.length && lines[i].trim() && !mdStartsBlock(lines[i], lines[i + 1])) para.push(lines[i++].replace(/^ +/, ''));
    out.push(h('p', {}, mdInline(para.join('\n').replace(/[ \t]+$/gm, ''))));
  }
  return out;
}

function renderMarkdown(text) {
  return h('div', { class: 'md' }, mdBlocks(String(text || '').replace(/\r\n?/g, '\n').split('\n')));
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
  state.token = null; state.me = null; state.data = {}; state.selected = null; state.sel.clear(); renderToolbar(); state.status.clear(); closeDetail(); clear($('list')); state.lastUpdated = 0; state.lastAttempt = 0; state.rateLimitUntil = 0;
  renderUpdated(); showView(); scheduleAuto();
}
function showView() {
  const on = !!state.token;
  $('login').hidden = on; $('dash').hidden = !on; $('controls').hidden = !on; $('userbox').hidden = !on;
}
$('loginform').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('token').value.trim();
  $('token').value = '';
  try {
    const me = await gh('/user');
    localStorage.setItem(TOKEN_KEY, state.token);
    $('username').textContent = me.login; state.me = me.login;
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
  if (auto !== true) { banner(''); permBanner(); }
  state.refreshing = true;
  $('refresh').disabled = true;
  const token = state.token;
  let results;
  try {
    results = await Promise.all(TABS.map((t) => loadTab(t).catch((e) => { banner(e.message); return null; })));
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

function setTab(id) {
  state.tab = id; localStorage.setItem(TAB_KEY, id); state.selected = null; state.cursor = null; state.sel.clear(); closeDetail(); renderTabs(); renderRepos(); renderList();
}

function renderTabs() {
  const nav = $('tabs'); clear(nav);
  for (const t of TABS) {
    nav.append(h('button', {
      role: 'tab', type: 'button', 'aria-selected': String(t.id === state.tab),
      onclick: () => setTab(t.id),
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
  const ul = $('list'), detail = $('detail'), y = window.scrollY, x = window.scrollX, dy = detail.scrollTop, ly = ul.scrollTop;
  buildList(ul);
  window.scrollTo(x, y); detail.scrollTop = dy; ul.scrollTop = ly;
}
function visibleItems() {
  const q = $('textfilter').value.toLowerCase(), repo = $('repofilter').value;
  return (state.data[state.tab] || []).filter((i) =>
    (!repo || repoOf(i) === repo) && (!q || (i.title + ' ' + repoOf(i) + ' ' + i.number).toLowerCase().includes(q)));
}
// Why a PR cannot be bulk-approved (null = it can). Search results carry user/state/draft.
function bulkReason(i) {
  if (!i.pull_request) return 'Not a pull request';
  if (state.me && i.user && i.user.login.toLowerCase() === state.me.toLowerCase()) return 'Your own PR: GitHub does not allow approving it';
  if (i.state !== 'open') return 'Closed or merged: cannot be reviewed';
  if (i.draft) return 'Draft: not ready for review';
  if (!state.me) return 'Signed-in user not known yet';
  return null;
}
function pruneSelection() {
  // The selection only ever holds PRs that are currently visible (tab + text/repo filters) and approvable.
  const cur = new Set(visibleItems().filter((i) => !bulkReason(i)).map((i) => i.id));
  for (const id of [...state.sel]) if (!cur.has(id)) state.sel.delete(id);
}
function renderToolbar() {
  const bar = $('bulkbar'), n = state.sel.size, show = n > 0 && !!(TABS.find((t) => t.id === state.tab) || {}).pr;
  const top = $('top'), before = top.offsetHeight, wasHidden = bar.hidden;
  bar.hidden = !show;
  $('bulkcount').textContent = n + ' selected';
  if (wasHidden !== bar.hidden && window.scrollY > 0) window.scrollBy(0, top.offsetHeight - before); // keep rows still
}
function toggleSel(i, on) {
  if (on && !bulkReason(i)) state.sel.add(i.id); else state.sel.delete(i.id);
  renderToolbar();
}
$('bulkclear').addEventListener('click', () => { state.sel.clear(); renderList(); renderToolbar(); });
$('bulkall').addEventListener('click', () => {
  for (const i of visibleItems()) if (!bulkReason(i)) state.sel.add(i.id);
  renderList(); renderToolbar();
});
$('bulkapprove').addEventListener('click', openBulk);

function buildList(ul) {
  clear(ul);
  pruneSelection(); renderToolbar();
  const items = visibleItems();
  if (!items.length) { ul.append(h('li', { class: 'empty' }, 'Nothing here.')); return; }
  for (const i of items) {
    const st = state.status.get(i.id);
    const link = safeUrl(i.html_url);
    const reason = i.pull_request ? bulkReason(i) : null;
    const where = `${repoOf(i)}#${i.number}`;
    const bulk = i.pull_request ? h('label', { class: 'bulk', title: reason || 'Select for bulk approve', onclick: (e) => e.stopPropagation() },
      h('input', { type: 'checkbox', 'aria-label': reason ? `${where} cannot be selected. ${reason}` : `Select ${where} for bulk approve`, disabled: !!reason, checked: !reason && state.sel.has(i.id),
        onchange: (e) => toggleSel(i, e.target.checked) })) : null;
    ul.append(h('li', { class: [state.selected === i.id ? 'sel' : '', state.cursor === i.id ? 'cur' : ''].join(' ').trim(), tabindex: '0', onclick: () => select(i), onkeydown: (e) => { if (e.key === 'Enter' && e.target.tagName !== 'INPUT') select(i); } },
      h('div', { class: 'row-title' }, bulk, i.title),
      h('div', { class: 'meta' },
        h('span', {}, `${repoOf(i)}#${i.number}`),
        ...i.labels.map((l) => h('span', { class: 'label' }, l.name)),
        h('span', {}, 'updated ' + ago(i.updated_at) + ' ago · opened ' + ago(i.created_at) + ' ago'),
        i.pull_request ? h('span', { class: st ? 'st-' + st.ci : 'st-loading', title: (st && st.ciTip) || null }, 'CI: ' + (st ? ciLabel(st.ci) : '…')) : null,
        i.pull_request ? h('span', { class: st ? 'st-' + st.review : 'st-loading' }, 'Review: ' + (st ? st.review : '…')) : null,
        reason ? h('span', { class: 'bulk-why' }, 'Not selectable: ' + reason) : null,
        link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'GitHub ↗') : null)));
  }
}

// ---- PR status (CI + review), fetched lazily with limited concurrency ----
function ciOf(checks, combined) {
  const runs = (checks && checks.check_runs) || [];
  const states = runs.map((r) => (r.status !== 'completed' ? 'pending'
    : ['success', 'neutral', 'skipped'].includes(r.conclusion) ? 'success' : 'failure'));
  if (combined && combined.total_count > 0) states.push(combined.state === 'success' ? 'success' : combined.state === 'pending' ? 'pending' : 'failure');
  if (!states.length) return null;
  return states.includes('failure') ? 'failure' : states.includes('pending') ? 'pending' : 'success';
}
const CI_LABEL = { none: 'none', noaccess: 'no access', error: 'error', unknown: 'unknown' };
const ciLabel = (ci) => CI_LABEL[ci] || ci;
const PERM_HINT = { checks: 'Checks: Read', combined: 'Commit statuses: Read', reviews: 'Pull requests: Read' };
// Derive the CI state from independently fetched sources (each is {ok,value}|{ok:false,error}).
function ciState(checks, combined) {
  const val = ciOf(checks.ok ? checks.value : null, combined.ok ? combined.value : null);
  if (val) return { ci: val, missing: [], ciTip: '' };
  const failed = [['checks', checks], ['combined', combined]].filter(([, r]) => !r.ok);
  const missing = failed.filter(([, r]) => r.error.status === 403 || r.error.status === 404).map(([k]) => PERM_HINT[k]);
  if (failed.length && missing.length === failed.length) return { ci: 'noaccess', missing, ciTip: 'Token lacks permission: ' + missing.join(' and ') };
  if (failed.length) return { ci: 'error', missing, ciTip: failed.map(([, r]) => r.error.message).join('; ') };
  return { ci: 'none', missing: [], ciTip: 'No CI configured for this commit' };
}
function reviewOf(reviews) {
  const latest = new Map();
  for (const r of reviews) if (r.state !== 'COMMENTED' && r.state !== 'PENDING' && r.user) latest.set(r.user.login, r.state);
  const v = [...latest.values()];
  return v.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : v.includes('APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const fatal = (r) => !r.ok && (r.error.status === 401 || r.error.status === 429);
async function prStatus(i) {
  const [owner, repo] = repoOf(i).split('/');
  const base = `/repos/${owner}/${repo}`;
  let pr = await gh(`${base}/pulls/${i.number}`);
  // mergeable is null while GitHub computes it; retry a few times.
  for (let n = 0; n < 3 && pr.mergeable == null && pr.state === 'open'; n++) {
    await sleep(1500);
    pr = await gh(`${base}/pulls/${i.number}`);
  }
  const [checks, combined, reviews] = await Promise.all([
    settle(gh(`${base}/commits/${pr.head.sha}/check-runs?per_page=100`)),
    settle(gh(`${base}/commits/${pr.head.sha}/status`)),
    settle(paged(`${base}/pulls/${i.number}/reviews`)),
  ]);
  for (const r of [checks, combined, reviews]) if (fatal(r)) throw r.error;
  const c = ciState(checks, combined);
  const rv = reviews.ok ? reviewOf(reviews.value) : 'unknown';
  const missing = [...c.missing];
  if (!reviews.ok && (reviews.error.status === 403 || reviews.error.status === 404)) missing.push(PERM_HINT.reviews);
  return { ci: c.ci, ciTip: c.ciTip, missing, review: rv, pr,
    checks: checks.ok ? checks.value : { check_runs: [] }, combined: combined.ok ? combined.value : null, reviews: reviews.ok ? reviews.value : [] };
}
function permBanner() {
  const miss = new Set();
  for (const st of state.status.values()) for (const m of st.missing) miss.add(m);
  const b = $('permbanner');
  b.hidden = !miss.size;
  b.textContent = miss.size ? 'Some status info is hidden because the token is missing permissions: add ' + [...miss].join(', ') + ' (Repository permissions) to the token.' : '';
}
async function loadPrStatuses() {
  const prs = [...new Map(TABS.filter((t) => t.pr).flatMap((t) => state.data[t.id] || []).map((i) => [i.id, i])).values()];
  let idx = 0;
  async function worker() {
    while (idx < prs.length) {
      const i = prs[idx++];
      try { state.status.set(i.id, await prStatus(i)); permBanner(); renderList(); }
      catch (e) {
        if (e.status === 401 || e.status === 429) { banner(e.message); idx = prs.length; }
        else state.status.set(i.id, { ci: 'error', ciTip: e.message, missing: [], review: 'unknown', pr: null, checks: { check_runs: [] }, combined: null, reviews: [] });
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  renderList();
}

// ---- detail ----
function closeDetail() { $('detail').hidden = true; $('layout').classList.remove('open'); }

async function select(i) {
  state.selected = i.id; state.cursor = i.id;
  renderList();
  const d = $('detail'); clear(d);
  d.hidden = false; $('layout').classList.add('open');
  d.append(h('p', {}, 'Loading…'));
  try {
    const [owner, repo] = repoOf(i).split('/');
    const base = `/repos/${owner}/${repo}`;
    const isPr = !!i.pull_request;
    const [full, comments, files, st, me] = await Promise.all([
      gh(`${base}/issues/${i.number}`),
      paged(`${base}/issues/${i.number}/comments`),
      isPr ? paged(`${base}/pulls/${i.number}/files`, 100) : [],
      isPr ? prStatus(i) : null,
      isPr ? getMe().catch(() => null) : null,
    ]);
    if (st) { state.status.set(i.id, st); permBanner(); }
    if (state.selected !== i.id) return;
    renderDetail(i, base, full, comments, files, st, me);
  } catch (e) { banner(e.message); closeDetail(); }
}

function renderDetail(i, base, full, comments, files, st, me) {
  const d = $('detail'); clear(d);
  const isPr = !!i.pull_request;
  const link = safeUrl(full.html_url);
  d.append(
    h('h3', {}, `${repoOf(i)}#${i.number}: ${full.title}`),
    h('div', { class: 'meta' }, h('span', {}, 'by ' + (full.user ? full.user.login : 'unknown')), h('span', {}, 'state: ' + full.state),
      link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open on GitHub ↗') : null,
      h('button', { type: 'button', onclick: () => { closeDetail(); state.selected = null; renderList(); } }, 'Close')),
    full.body ? h('div', { class: 'body' }, renderMarkdown(full.body)) : h('div', { class: 'body' }, '(no description)'));

  if (isPr && st) {
    d.append(h('h3', {}, 'Status'),
      h('div', { class: 'meta' },
        h('span', { class: 'st-' + st.ci, title: st.ciTip || null }, 'CI: ' + ciLabel(st.ci)),
        h('span', { class: 'st-' + st.review }, 'Review: ' + st.review),
        h('span', {}, 'mergeable: ' + (!st.pr ? 'unknown' : st.pr.mergeable == null && st.pr.state === 'open' ? 'computing…' : (st.pr.mergeable_state || 'unknown')))),
      st.ciTip ? h('div', { class: 'meta' }, st.ciTip) : null,
      h('ul', {}, ...(st.checks.check_runs || []).map((r) => h('li', {}, `${r.name}: ${r.status === 'completed' ? r.conclusion : r.status}`))));
    d.append(h('h3', {}, `Changed files (${files.length}${files.length >= 100 ? '+' : ''})`),
      h('ul', { class: 'files' }, ...files.map((f) => h('li', {}, `${f.filename} (+${f.additions} −${f.deletions})`))));
  }

  d.append(h('h3', {}, `Comments (${comments.length})`),
    ...comments.map((c) => h('div', { class: 'comment' },
      h('div', { class: 'meta' }, (c.user ? c.user.login : 'unknown') + ' · ' + ago(c.created_at) + ' ago'),
      h('div', { class: 'body' }, renderMarkdown(c.body)))));

  const ta = h('textarea', { placeholder: 'Comment (optional for approve)' });
  const btns = [];
  const act = (label, fn, cls = '') => {
    const b = h('button', { type: 'button', class: cls, onclick: async () => {
      btns.forEach((x) => { x.disabled = true; });
      state.busy++;
      let held = true;
      const release = () => { if (held) { held = false; state.busy--; } };
      try { await fn(); banner(label + ': done', true); release(); await refresh(); if (state.selected === i.id) select(i); }
      catch (e) { banner(e.message); btns.forEach((x) => { x.disabled = x.dataset.locked === '1'; }); }
      finally { release(); scheduleAuto(); }
    } }, label);
    btns.push(b); return b;
  };
  const text = () => ta.value.trim();
  const needText = () => { if (!text()) throw new ApiError('Enter a comment first.'); return text(); };
  const review = (event) => gh(`${base}/pulls/${i.number}/reviews`, { method: 'POST', body: { event, ...(text() ? { body: text() } : {}) } });
  const comment = act('Comment', () => gh(`${base}/issues/${i.number}/comments`, { method: 'POST', body: { body: needText() } }));
  const row = h('div', { class: 'actions' }, comment);
  let reviewNote = null;
  if (isPr) {
    const own = !!(me && full.user && full.user.login.toLowerCase() === me.toLowerCase());
    const isDraft = !!(full.draft || (st && st.pr && st.pr.draft));
    const noReview = own || full.state !== 'open';
    const approve = act('Approve', () => review('APPROVE'), 'primary');
    const reqChanges = act('Request changes', () => { needText(); return review('REQUEST_CHANGES'); }, 'danger');
    if (noReview) { approve.disabled = true; reqChanges.disabled = true; approve.dataset.locked = reqChanges.dataset.locked = '1'; }
    reviewNote = own ? 'GitHub does not allow approving your own PR'
      : full.state !== 'open' ? 'This PR is closed or merged, so it cannot be reviewed'
      : isDraft ? 'This PR is a draft; reviews may be rejected until it is ready' : null;
    row.append(
      approve, reqChanges,
      act('Merge', async () => {
        if (!confirm(`Merge ${repoOf(i)}#${i.number}?\n\n${full.title}`)) throw new ApiError('Merge cancelled.');
        await gh(`${base}/pulls/${i.number}/merge`, { method: 'PUT', body: { merge_method: 'merge' } });
      }, 'danger'));
  }
  const closed = full.state === 'closed';
  row.append(act(closed ? 'Reopen' : 'Close', () => gh(`${base}/issues/${i.number}`, { method: 'PATCH', body: { state: closed ? 'open' : 'closed' } }), isPr ? 'danger' : ''));
  d.append(h('h3', {}, 'Actions'), ta, row, reviewNote ? h('div', { class: 'meta review-note' }, reviewNote) : null);
}

// ---- bulk approve ----
// bulk = { rows: [{ item, status: pending|running|done|failed|skipped, msg, el }], phase: confirm|running|done, comment, note, ta, returnFocus }
let bulk = null;
const bulkOpen = () => !$('bulkoverlay').hidden;
const rowWhere = (r) => `${repoOf(r.item)}#${r.item.number}`;
const ROW_STATUS = { pending: ['pending', 'st-pending'], running: ['approving…', 'st-pending'], done: ['approved', 'st-success'], failed: ['failed', 'st-failure'], skipped: ['not attempted', 'st-none'] };
function paintRow(r) {
  const [label, cls] = ROW_STATUS[r.status];
  r.el.className = 'bulk-status ' + cls;
  r.el.textContent = label + (r.msg ? ': ' + r.msg : '') + (r.tries > 1 ? ` (attempt ${r.tries})` : '');
}
function openBulk() {
  if (bulkOpen() || state.busy > 0) return;
  const items = visibleSelected();
  if (!items.length) return;
  bulk = { rows: items.map((item) => ({ item, status: 'pending', msg: '', el: null, tries: 0, round: 0, prev: null })), phase: 'confirm', round: 0, retried: 0, comment: '', note: '', returnFocus: document.activeElement,
    ta: h('textarea', { id: 'bulkcomment', placeholder: 'Optional comment, added to every approval', 'aria-label': 'Optional shared comment' }) };
  $('bulkoverlay').hidden = false;
  renderBulk();
}
function visibleSelected() {
  return visibleItems().filter((i) => state.sel.has(i.id) && !bulkReason(i));
}
function closeBulk() {
  if (!bulk || bulk.phase === 'running') return;
  $('bulkoverlay').hidden = true;
  const back = bulk.returnFocus; bulk = null;
  clear($('bulk'));
  renderList(); renderToolbar();
  const target = back && back.isConnected && !back.closest('[hidden]') ? back : document.body;
  if (target !== document.body) target.focus();
}
function renderBulk() {
  const d = $('bulk'); clear(d);
  const n = bulk.rows.length, ph = bulk.phase;
  const ok = bulk.rows.filter((r) => r.status === 'done').length;
  const failed = bulk.rows.filter((r) => r.status === 'failed').length;
  const skipped = bulk.rows.filter((r) => r.status === 'skipped').length;
  d.append(h('h2', { id: 'bulktitle' }, ph === 'confirm' ? `Approve ${n} pull request${n === 1 ? '' : 's'}?` : ph === 'running' ? 'Approving…' : 'Bulk approve finished'));
  const ul = h('ul', { class: 'bulk-list' });
  for (const r of bulk.rows) {
    r.el = h('span', {});
    if (ph !== 'confirm') paintRow(r);
    ul.append(h('li', {}, h('span', { class: 'bulk-pr' }, rowWhere(r) + ' '), r.item.title, ' ', r.el));
  }
  d.append(ul);
  const btns = h('div', { class: 'actions' });
  let focus = d;
  if (ph === 'confirm') {
    d.append(h('p', { class: 'meta' }, 'Each PR gets an APPROVE review. This cannot be undone from here.'), bulk.ta);
    const cancel = h('button', { type: 'button', id: 'bulkcancel', onclick: closeBulk }, 'Cancel');
    btns.append(cancel, h('button', { type: 'button', id: 'bulkconfirm', class: 'primary', onclick: () => { if (bulk.phase !== 'confirm') return; bulk.comment = bulk.ta.value.trim(); runBulk(bulk.rows); } }, `Confirm: approve ${n}`));
    focus = cancel;
  } else if (ph === 'done') {
    let summary = `${ok} approved, ${failed} failed` + (skipped ? `, ${skipped} not attempted` : '');
    if (bulk.round > 1) {
      const mine = bulk.rows.filter((r) => r.round === bulk.round);
      summary += ` (retry round ${bulk.round}: ${mine.filter((r) => r.status === 'done').length} approved, ${mine.filter((r) => r.status === 'failed').length} failed, ${bulk.retried - mine.length} not retried)`;
    }
    d.append(h('p', { id: 'bulksummary', role: 'status', class: failed || skipped ? 'bulk-bad' : 'bulk-good' }, summary), bulk.note ? h('p', { class: 'bulk-bad' }, bulk.note) : null);
    if (failed || skipped) btns.append(h('button', { type: 'button', id: 'bulkretry', onclick: () => {
      if (bulk.phase !== 'done') return;
      const again = bulk.rows.filter((r) => r.status === 'failed' || r.status === 'skipped');
      for (const r of again) { r.prev = { status: r.status, msg: r.msg }; r.status = 'pending'; r.msg = ''; }
      bulk.note = ''; bulk.retried = again.length; runBulk(again);
    } }, skipped ? 'Retry failed and not attempted' : 'Retry failed'));
    const close = h('button', { type: 'button', id: 'bulkclose', onclick: closeBulk }, 'Close');
    btns.append(close);
    focus = close;
  } else {
    d.append(h('p', { class: 'meta', role: 'status' }, 'Working… please keep this window open.'));
  }
  d.append(btns);
  focus.focus();
}
async function runBulk(rows) {
  if (bulk.phase === 'running') return;
  bulk.round++; if (bulk.round === 1) bulk.retried = rows.length;
  bulk.phase = 'running'; renderBulk();
  state.busy++;
  const token = state.token;
  let stop = '';
  try {
    for (const r of rows) {
      if (!stop && Date.now() < state.rateLimitUntil) stop = 'Rate limit active until ' + new Date(state.rateLimitUntil).toLocaleTimeString() + '.';
      if (stop) {
        // Not tried this round: a row that already failed keeps its status and reason.
        if (r.prev) { r.status = r.prev.status; r.msg = r.prev.msg; } else r.status = 'skipped';
        paintRow(r); continue;
      }
      r.status = 'running'; r.tries++; r.round = bulk.round; r.prev = null; paintRow(r);
      const [owner, repo] = repoOf(r.item).split('/');
      try {
        await gh(`/repos/${owner}/${repo}/pulls/${r.item.number}/reviews`, { method: 'POST', body: { event: 'APPROVE', ...(bulk.comment ? { body: bulk.comment } : {}) } });
        r.status = 'done'; r.msg = ''; state.sel.delete(r.item.id);
      } catch (e) {
        r.status = 'failed'; r.msg = e.message;
        if (e.status === 401) stop = 'Your token was rejected (401), so the batch was stopped and you were signed out. Sign in again and retry.';
        else if (e.status === 429 || (e.status === 403 && /rate limit/i.test(e.message))) stop = 'GitHub rate limit reached, so the batch was stopped: ' + e.message;
      }
      paintRow(r);
    }
  } finally { state.busy--; }
  bulk.note = stop; bulk.phase = 'done';
  renderBulk();
  if (state.token === token) { await refresh(); }
  scheduleAuto();
}
$('bulkoverlay').addEventListener('click', (e) => { if (e.target === $('bulkoverlay')) closeBulk(); });
$('bulkoverlay').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeBulk(); return; }
  if (e.key !== 'Tab') return;
  const f = [...$('bulk').querySelectorAll('button:not(:disabled), textarea')];
  if (!f.length) { e.preventDefault(); $('bulk').focus(); return; }
  const at = f.indexOf(document.activeElement);
  if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
});
document.addEventListener('focusin', (e) => {
  if (bulkOpen() && !$('bulkoverlay').contains(e.target)) { const f = $('bulk').querySelector('button:not(:disabled), textarea'); (f || $('bulk')).focus(); }
});

// ---- keyboard shortcuts ----
const isTyping = (el) => !!el && ((['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && el.type !== 'checkbox') || el.isContentEditable);
const helpOpen = () => !$('helpoverlay').hidden;
let helpReturn = null;
function showHelp(on) {
  $('helpoverlay').hidden = !on;
  if (on) { helpReturn = document.activeElement; $('helpclose').focus(); }
  else { if ($('help').contains(document.activeElement)) document.activeElement.blur(); if (helpReturn && helpReturn.isConnected) helpReturn.focus(); helpReturn = null; }
}
$('helpclose').addEventListener('click', () => showHelp(false));
$('helpoverlay').addEventListener('click', (e) => { if (e.target === $('helpoverlay')) showHelp(false); });

function moveCursor(delta) {
  const items = visibleItems();
  if (!items.length) return;
  const at = items.findIndex((i) => i.id === state.cursor);
  const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, at + delta));
  state.cursor = items[next].id;
  renderList();
  const row = $('list').querySelector('li.cur');
  if (row) row.scrollIntoView({ block: 'nearest' }); // honours html scroll-padding-top (sticky header)
}
const cursorItem = () => visibleItems().find((i) => i.id === state.cursor);

document.addEventListener('keydown', (e) => {
  if (!state.token || bulkOpen() || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (helpOpen()) {
    if (k === 'Escape' || k === '?') { e.preventDefault(); showHelp(false); }
    else if (k === 'Tab') { e.preventDefault(); $('helpclose').focus(); }
    return;
  }
  if (k === 'Escape') {
    if (e.target === $('textfilter')) { e.preventDefault(); $('textfilter').blur(); }
    else if (!isTyping(e.target) && !$('detail').hidden) { e.preventDefault(); closeDetail(); state.selected = null; renderList(); }
    return;
  }
  if (isTyping(e.target)) return;
  const n = /^[1-9]$/.test(k) ? Number(k) : 0;
  if (n && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1].id); }
  else if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (k === 'o' || (k === 'Enter' && e.target === document.body)) { const i = cursorItem(); if (i) { e.preventDefault(); select(i); } }
  else if (k === 'g') { const i = cursorItem(), u = i && safeUrl(i.html_url); if (u) { e.preventDefault(); window.open(u, '_blank', 'noopener'); } }
  else if (k === 'r') { e.preventDefault(); if (!autoBlocked()) refresh(); }
  else if (k === '/') { e.preventDefault(); $('textfilter').focus(); }
  else if (k === '?') { e.preventDefault(); showHelp(true); }
});

// ---- init ----
state.token = localStorage.getItem(TOKEN_KEY);
showView();
if (state.token) {
  gh('/user').then((me) => { $('username').textContent = me.login; state.me = me.login; refresh(); }).catch((e) => banner(e.message));
}

// Keep scroll-padding in sync with the sticky header height.
{
  const top = $('top');
  const sync = () => document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px');
  new ResizeObserver(sync).observe(top); sync();
}
