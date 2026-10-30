// A picture that failed is asked for again (feedback #44: after a material download many icons stayed letters on a disc).
// The bond icons are refused until the fallback shows, then allowed: the icon comes back without a reload.
// SP_E2E=1 CHROME_PATH=/path/to/chrome node --test test/ui/image-retry.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

test('a failed bond icon returns after its rest', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run', timeout: 60000 }, async (t) => {
  const { startServer } = await import('../../server/index.js');
  const puppeteer = (await import('puppeteer-core')).default;
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  t.after(async () => { await browser.close(); await srv.close(); });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  let refuse = true;
  await page.setRequestInterception(true);
  page.on('request', (r) => { if (refuse && /\/bond\//.test(r.url())) r.abort(); else r.continue(); });
  await page.goto(`http://127.0.0.1:${srv.port}/dev/game-mock.html?shot=1&render=fallback&phase=PREP`, { waitUntil: 'load' });
  await page.waitForSelector('.bond__glyph', { timeout: 15000 });
  const before = await page.$$eval('.bond__glyph', (els) => els.length);
  assert.ok(before > 0);
  refuse = false;
  await page.waitForFunction(() => !document.querySelector('.bond__glyph') && document.querySelector('.bond__icon'), { timeout: 20000 });
});
