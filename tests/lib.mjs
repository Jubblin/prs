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
// Browser under test: BROWSER=chromium (default) | firefox | webkit.
export function launchBrowser(pw) {
  const name = process.env.BROWSER || 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(name)) { console.error(`Unknown BROWSER "${name}" (use chromium, firefox or webkit)`); process.exit(2); }
  return pw[name].launch();
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
export function serve(dir = root) {
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// token=null -> signed-out page. Returns { page, mock, errors, hosts }.
export async function open(browser, url, { token = 'tok', mock = createMock(), viewport = { width: 1280, height: 800 }, colorScheme = 'light', storage = {} } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [], hosts = new Set();
  // Fetches still in flight when the page navigates (tests reload to install a fake clock) are cancelled by the engine.
  // WebKit reports each as an uncaught "Fetch API cannot load ... due to access control checks" error; Chromium and Firefox stay silent.
  // That is the engine tearing down the old document, not an app bug, so errors that arrive during a navigation are ignored.
  let navigating = false;
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigating = true; });
  page.on('load', () => { navigating = false; });
  page.on('pageerror', (e) => { if (!(navigating && /access control checks/.test(e.message))) errors.push(e.message); });
  page.on('dialog', (d) => d.dismiss());
  await page.route('https://api.github.com/**', (r) => mock.handle(r));
  await page.route(/^https:\/\/(?!api\.github\.com)[^/]*(github\.com|githubusercontent\.com|githubassets\.com)\//, (r) => { hosts.add(new URL(r.request().url()).hostname); return r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
  page.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1') hosts.add(u.hostname); });
  await page.route(/evil\.example/, (r) => r.abort());
  // securitypolicyviolation events work in every browser; console-message wording does not (Firefox differs).
  // WebKit reports a style-src-attr violation for every <select> element itself (engine-generated; reproduces on a bare page
  // with only a <select> and style-src 'self'; no inline style comes from the app). Ignore exactly those, located by the
  // line of each <select> tag in index.html, so any other inline-style violation still fails the CSP checks.
  const selectLines = fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('\n').flatMap((l, i) => (l.includes('<select') && !l.includes('style=') ? [i + 1] : []));
  await page.addInitScript((sel) => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => { if (e.violatedDirective === 'style-src-attr' && sel.includes(e.lineNumber)) return; window.__csp.push(e.violatedDirective + ' ' + e.blockedURI); }); }, selectLines);
  const init = { ...(token ? { gh_dashboard_token: token } : {}), ...storage };
  await page.addInitScript((s) => { if (!sessionStorage.__init) { sessionStorage.__init = 1; for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } }, init);
  await page.goto(url);
  return { page, mock, errors, hosts, context };
}
// Wait until every PR row has a final CI status (no "…").
export const settled = (page) => page.waitForFunction(() => document.querySelectorAll('#list li').length > 0 && ![...document.querySelectorAll('#list .meta span')].some((s) => s.textContent === 'CI: …' || s.textContent === 'Review: …'), null, { timeout: 15000 });
