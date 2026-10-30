// Regenerates docs/img/*.png against the mock API. Usage: node tests/shots.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, serve, open, settled } from './lib.mjs';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/img');
const { chromium } = loadPlaywright();
const { srv, url } = await serve();
const browser = await chromium.launch();
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, name + '.png'), ...opts });
const review = async (page) => { await page.locator('#tabs button').nth(1).click(); await settled(page); };

{ // light desktop: list, detail, bulk, help
  const { page, context } = await open(browser, url);
  await review(page);
  await shot(page, 'list');
  await page.locator('#list li', { hasText: 'Add dark mode' }).click();
  await page.locator('#detail h3', { hasText: 'Comments' }).waitFor();
  await shot(page, 'detail');
  await page.keyboard.press('Escape');
  await page.locator('#list li', { hasText: 'Add dark mode' }).locator('input').check();
  await page.locator('#list li', { hasText: 'Bump deps' }).locator('input').check();
  await page.locator('#bulkapprove').click();
  await page.locator('#bulk textarea').fill('Thanks, approving the batch.');
  await shot(page, 'bulk-approve');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await shot(page, 'help');
  await context.close();
}
{ // dark
  const { page, context } = await open(browser, url, { colorScheme: 'dark' });
  await review(page);
  await page.locator('#list li', { hasText: 'Add dark mode' }).click();
  await page.locator('#detail h3', { hasText: 'Comments' }).waitFor();
  await shot(page, 'dark');
  await context.close();
}
{ // mobile
  const { page, context } = await open(browser, url, { viewport: { width: 390, height: 800 } });
  await review(page);
  await shot(page, 'mobile');
  await context.close();
}
await browser.close(); srv.close();
console.log('wrote screenshots to docs/img');
