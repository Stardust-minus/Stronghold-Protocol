// Opt-in real localhost app/WS/Worker/browser check. All provider/redirect failures are local fixtures, never live CDN probes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';
import { give, legalTileFor } from '../match/harness.js';

const enabled = process.env.SP_E2E === '1';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=', 'base64');
class StreamingMatch extends Match {
  constructor(options) { super({ ...options, clientCombat: false, verify: 'off', timerScale: 0.2, combatSpeed: 1, botRehearsal: 0 }); }
}

test('browser survives two-redirect CDN failures with bounded public-material OpenI retries', { skip: !enabled, timeout: 120000 }, async () => {
  const out = process.env.SP_MATERIAL_EVIDENCE || mkdtempSync(fileURLToPath(new URL('../../.cache/stardust/browser-openi-fallback-', import.meta.url)));
  const report = { ok: false, scope: 'localhost app, one real combat Worker, synthetic local CDN failures', productionAccessed: false, externalRequestsBlocked: 0, errors: [], primary: [], forced: [] };
  let app, browser, provider, page;
  const timers = new Set();
  try {
    app = await startServer({ port: 0, host: '127.0.0.1', combatWorkers: 1, trialWorkers: 0, snapshotHz: 10, wsCompression: 'on', MatchClass: StreamingMatch, quiet: true, seedFn: () => 731 });
    provider = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname.startsWith('/jump/')) {
        res.writeHead(302, { 'Access-Control-Allow-Origin': '*', Location: '/cdn/' + url.pathname.slice(6) }); res.end(); return;
      }
      const path = decodeURIComponent(url.pathname.slice(5));
      if (path.includes('timeout') || path.includes('stale')) {
        const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(pixel); } }, 1500);
        timers.add(timer); return;
      }
      if (path.endsWith('.json')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"notReadableWithoutCORS":true}'); return; }
      if (path.endsWith('.skel')) { res.writeHead(403, { 'Access-Control-Allow-Origin': '*' }); res.end('fixture forbidden'); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (path.endsWith('.atlas') || path.startsWith('/media/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>fixture provider error</html>'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('fixture invalid image');
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', req => {
      const raw = req.url();
      if (/^(data:|blob:|about:)/.test(raw)) { void req.continue(); return; }
      const url = new URL(raw);
      if (url.hostname !== '127.0.0.1') { report.externalRequestsBlocked++; void req.abort(); return; }
      if (url.origin !== app.url || !/^\/(?:assets|media)\//.test(url.pathname)) { void req.continue(); return; }
      const fixture = url.pathname.startsWith('/assets/test/browser-');
      if (url.search === '?sp_source=openi') {
        report.forced.push(url.pathname);
        if (fixture) {
          if (url.pathname.includes('both-fail')) void req.respond({ status: 503, body: 'fixture failure' });
          else if (url.pathname.endsWith('.json')) void req.respond({ status: 200, contentType: 'application/json', body: '{"fixture":true}' });
          else void req.respond({ status: 200, contentType: 'image/png', body: pixel });
        } else void req.continue();
        return;
      }
      if (url.pathname.includes('healthy')) { void req.respond({ status: 200, contentType: 'image/png', body: pixel }); return; }
      report.primary.push(url.pathname);
      void req.respond({ status: 302, headers: { Location: providerUrl + '/jump/' + encodeURIComponent(url.pathname), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    });
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.title-login input'), { timeout: 30000 });
    report.dom = await page.evaluate(async () => {
      const { MaterialImage } = await import('/js/ui/materialImage.js');
      const { h, render } = await import('/vendor/preact.module.js');
      const { fetchMaterial } = await import('/js/materialFallback.js');
      const root = document.createElement('div'); document.body.appendChild(root);
      let loaded = 0, failed = 0;
      const paint = src => render(h(MaterialImage, { src, timeoutMs: 80, onLoad: () => loaded++, onError: () => failed++ }), root);
      const wait = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 20)); if (!predicate()) throw new Error('DOM fixture did not settle'); };
      paint('/assets/test/browser-timeout.png'); await wait(() => loaded === 1);
      const timeoutSrc = root.querySelector('img').getAttribute('src');
      paint('/assets/test/browser-both-fail.png'); await wait(() => failed === 1);
      paint('/assets/test/browser-stale.png');
      await new Promise(resolve => setTimeout(resolve, 20));
      paint('/assets/test/browser-healthy.png'); await wait(() => loaded === 2);
      await new Promise(resolve => setTimeout(resolve, 150));
      const latestSrc = root.querySelector('img').getAttribute('src');
      const json = await fetchMaterial('/assets/test/browser-cors.json', res => res.json());
      render(null, root); root.remove();
      return { loaded, failed, timeoutSrc, latestSrc, json };
    });
    assert.deepEqual(report.dom, { loaded: 2, failed: 1, timeoutSrc: '/assets/test/browser-timeout.png?sp_source=openi', latestSrc: '/assets/test/browser-healthy.png', json: { fixture: true } });
    assert.equal(report.forced.includes('/assets/test/browser-stale.png'), false, 'old source timer is cancelled');
    assert.equal(report.forced.includes('/assets/test/browser-healthy.png'), false, 'healthy image is not duplicated');
    assert.equal(report.forced.filter(path => path.includes('both-fail')).length, 1, 'both failures cannot loop');
    await page.type('.title-login input', 'Fallback Test'); await page.click('.title-login button');
    await page.waitForSelector('.lobby-screen', { timeout: 20000 });
    const request = (type, fields = {}) => page.evaluate((type, fields) => globalThis.__SP__.net.request(type, fields).then(() => true), type, fields);
    await request('room.create', { mode: 'solo', difficulty: 'NORMAL' }); await request('room.start');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK'); await request('g.infoReady');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'BAND_DRAFT'); await request('g.band', { bandId: 'band_bldsk' });
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP');
    const state = await page.evaluate(() => ({ player: globalThis.__SP__.store.get().me.playerId, room: globalThis.__SP__.store.get().room.code }));
    const match = app.lobby.getRoom(state.room).match, ps = match.players.get(state.player), chess = 'chess_char_1_10_a';
    const piece = give(match, ps, chess, 'board', legalTileFor(match, ps, chess));
    match.wave = { ...match.wave, timeLimit: 90, spawns: [{ ...match.wave.spawns[0], time: 20, count: 1, interval: 0 }] };
    match.markPrivate(ps); match.flush(true);
    report.spine = await page.evaluate(async () => {
      const { assets } = await import('/js/assets.js');
      const { ensurePixi } = await import('/js/render/app/pixi.js');
      await assets.ready(); await ensurePixi();
      const id = Object.keys(assets.manifest.chars).find(id => assets.spineEntry(id) && assets.avatar(id));
      const entry = assets.spineEntry(id);
      const model = await assets.spine.acquire(entry);
      const image = await assets.image(assets.avatar(id));
      const result = { skel: entry.skel, atlas: entry.atlas, textures: entry.textures, animations: model.animations.length, imageWidth: image?.naturalWidth };
      assets.spine.release(entry); return result;
    });
    assert.ok(report.spine.animations > 0 && report.spine.imageWidth > 0);
    for (const path of [report.spine.skel, report.spine.atlas, ...report.spine.textures]) assert.ok(report.forced.includes(path), path + ' actually used OpenI');
    report.legacyImageTexture = await page.evaluate(async () => {
      const P = globalThis.PIXI, parser = P.Assets.loader.parsers.find(p => p.name === 'loadTextures');
      const previous = parser.config.preferCreateImageBitmap;
      const path = '/assets/test/browser-image.png';
      try {
        parser.config.preferCreateImageBitmap = false;
        const texture = await P.Assets.load(path);
        const valid = texture.valid;
        const key = new URL(path, location.origin).href;
        await P.Assets.unload(path);
        return { valid, unloaded: !P.Assets.loader.promiseCache[key] && !P.Assets.cache.has(path) };
      } finally { parser.config.preferCreateImageBitmap = previous; }
    });
    assert.deepEqual(report.legacyImageTexture, { valid: true, unloaded: true });
    assert.ok(report.forced.some(path => path.startsWith('/media/')), 'actual Web Audio load used OpenI');
    assert.ok(report.forced.some(path => path.endsWith('.obj')), 'unusable OBJ body used OpenI');
    assert.ok(report.forced.some(path => path.includes('sprite_shadow')), 'direct shadow texture uses the shared image loader');
    await page.waitForFunction(uid => !!globalThis.__SP_VIEW__?.pieceScreenRect(uid), { timeout: 20000 }, piece.uid);
    await page.screenshot({ path: out + '/prep-desktop.png' });
    await page.click('.readybtn');
    await new Promise(resolve => setTimeout(resolve, 300));
    await page.evaluate(() => [...document.querySelectorAll('.modal__actions button')].find(button => button.textContent.includes('准备就绪'))?.click());
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'COMBAT', { timeout: 20000 });
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.field?.unitStats?.length > 0, { timeout: 20000 });
    report.renderer = await page.evaluate(() => globalThis.__SP_VIEW__?.kind);
    assert.equal(report.renderer, 'engine');
    await new Promise(resolve => setTimeout(resolve, 1500));
    await page.screenshot({ path: out + '/combat-desktop.png' });
    await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
    // Changing mobile emulation can reload Chromium. Wait for the restored scene, not just the responsive HUD.
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.kind === 'engine' && globalThis.__SP_VIEW__.raw.stats().units > 0, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 1000));
    report.phoneEmulatedRenderer = await page.evaluate(() => ({ kind: globalThis.__SP_VIEW__.kind, units: globalThis.__SP_VIEW__.raw.stats().units }));
    await page.screenshot({ path: out + '/phone-emulated.png' });
    assert.deepEqual(report.errors, []); assert.equal(report.externalRequestsBlocked, 0);
    report.ok = true;
  } catch (error) {
    report.failure = error.message;
    try {
      report.scene = await page?.evaluate(() => ({ kind: globalThis.__SP_VIEW__?.kind, stats: globalThis.__SP_VIEW__?.raw?.stats?.(),
        phase: globalThis.__SP__?.store.get().match.public?.phase, canvases: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height })) }));
      await page?.screenshot({ path: out + '/failure.png' });
    } catch { /* evidence only */ }
    throw error;
  } finally {
    await browser?.close(); await app?.close();
    for (const timer of timers) clearTimeout(timer);
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    writeFileSync(out + '/browser.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Material fallback browser evidence: ' + out);
  }
});
