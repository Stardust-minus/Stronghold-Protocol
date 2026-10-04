import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { startServer } from '../server.mjs';

const chrome = process.env.CHROME_PATH;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stop = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

test('browser does not mix display/CSS and CORS image caches; both variants retain the same signature',
  { skip: !chrome || !existsSync(chrome) }, async t => {
    const now = Date.now();
    const entry = { requestPath: '/assets/image.png', fileName: 'releases/test/assets/image.png', bytes: image.length,
      sha256: '0'.repeat(64), mime: 'image/png' };
    const manifest = { schemaVersion: 1, release: 'test', dataset: 'Stardust_minus/arknight_assets',
      apiOrigin: 'https://openi.pcl.ac.cn', ossOrigin: 'https://obs.cn-south-222.ai.pcl.cn',
      ossPathPrefix: '/bucket/dataset/', fallbackBase: 'https://ark-asset.hanabi-ai.cn:25442/releases/test', entries: [entry] };
    const signed = manifest.ossOrigin + manifest.ossPathPrefix + entry.fileName + '?' + new URLSearchParams({
      AWSAccessKeyId: 'test-only', Signature: 'test-only', Expires: String(Math.floor(now / 1000) + 3600),
    });
    let apiCalls = 0;
    const resolver = await startServer({ manifest, host: '127.0.0.1', port: 0,
      fetchImpl: async () => { apiCalls++; return new Response(null, { status: 301, headers: { Location: signed } }); } });
    t.after(() => resolver.close());
    const seen = [];
    const storage = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      seen.push({ variant: url.searchParams.get('sp_request'), cors: !!req.headers.origin });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      // Match OBS: no ACAO and no Vary when Origin is absent.
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(image);
    });
    await listen(storage); t.after(() => stop(storage));
    const front = http.createServer((req, res) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Image cache test</title>'); return; }
      if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const headers = {};
      for (const name of ['origin', 'sec-fetch-mode']) if (req.headers[name]) headers[name] = req.headers[name];
      const upstream = http.request({ host: '127.0.0.1', port: resolver.server.address().port, path: req.url, headers }, reply => {
        const copied = { ...reply.headers };
        if (copied.location) {
          const destination = new URL(copied.location);
          assert.equal(destination.origin, manifest.ossOrigin);
          // Only the fixture changes the origin so the browser test makes no external network calls.
          copied.location = `http://127.0.0.1:${storage.address().port}${destination.pathname}${destination.search}`;
        }
        res.writeHead(reply.statusCode, copied); reply.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); upstream.end();
    });
    await listen(front); t.after(() => stop(front));
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const errors = [];
    for (const order of [['display', 'cors', 'display', 'cors'], ['cors', 'display', 'cors'], ['css', 'cors', 'display', 'cors']]) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.name));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(`http://127.0.0.1:${front.address().port}`);
      const checks = await page.evaluate(async modes => {
        const results = [], url = '/assets/image.png';
        for (const mode of modes) {
          if (mode === 'css') {
            const div = document.createElement('div');
            div.style.cssText = 'width:10px;height:10px;background-size:cover';
            div.style.backgroundImage = `url("${url}")`; document.body.append(div);
            await new Promise((resolve, reject) => {
              const deadline = performance.now() + 5000;
              const check = () => {
                if (performance.getEntriesByName(new URL(url, location.href).href).length) resolve();
                else if (performance.now() > deadline) reject(new Error('CSS image did not load'));
                else setTimeout(check, 10);
              };
              check();
            });
            results.push(true); continue;
          }
          const img = new Image();
          if (mode === 'cors') img.crossOrigin = 'anonymous';
          await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('image failed')); img.src = url; });
          document.body.append(img);
          if (mode === 'cors') {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); ctx.getImageData(0, 0, 1, 1);
          }
          results.push(img.naturalWidth === 1);
        }
        return results;
      }, order);
      assert.ok(checks.every(Boolean)); await context.close();
    }
    assert.deepEqual(errors, []);
    assert.ok(seen.some(row => row.variant === 'display' && !row.cors));
    assert.ok(seen.some(row => row.variant === 'cors' && row.cors));
    assert.equal(apiCalls, 1);
  });
