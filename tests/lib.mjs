import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMock } from './mock-github.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export function loadPlaywright() {
  try { return require('playwright'); } catch { console.error('Playwright not found. See "Running the mocked-API tests" in docs/TESTING.md'); process.exit(2); }
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
export function serve() {
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// token=null -> signed-out page. Returns { page, mock, errors, hosts, csp }.
export async function open(browser, url, { token = 'tok', mock = createMock(), viewport = { width: 1280, height: 800 }, colorScheme = 'light', storage = {} } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [], hosts = new Set(), csp = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
  page.on('dialog', (d) => d.dismiss());
  await page.route('https://api.github.com/**', (r) => mock.handle(r));
  await page.route(/^https:\/\/(?!api\.github\.com)[^/]*(github\.com|githubusercontent\.com|githubassets\.com)\//, (r) => { hosts.add(new URL(r.request().url()).hostname); return r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
  page.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1') hosts.add(u.hostname); });
  await page.route(/evil\.example/, (r) => r.abort());
  const init = { ...(token ? { gh_dashboard_token: token } : {}), ...storage };
  await page.addInitScript((s) => { if (!sessionStorage.__init) { sessionStorage.__init = 1; for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } }, init);
  await page.goto(url);
  return { page, mock, errors, hosts, csp, context };
}
// Wait until every PR row has a final CI status (no "…").
export const settled = (page) => page.waitForFunction(() => document.querySelectorAll('#list li').length > 0 && ![...document.querySelectorAll('#list .meta span')].some((s) => s.textContent === 'CI: …' || s.textContent === 'Review: …'), null, { timeout: 15000 });
