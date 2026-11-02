// Real-server browser E2E of 联动干员 (shared/experimental.js collabOps; ui/collab.js; docs/EXPERIMENTAL-MULTIPLAYER.md):
// the host of a private co-op room turns it on from 规则 — the copyright warning's confirm stays disabled for its 5 s
// hold (a press meanwhile does nothing, 不开启 keeps it off) —, both players then see the room's notice, both pages
// fetch the collab pack (/data/assets-collab.json) only now, the guest's 自选 picker lists 灰烬 with the 联动 tag, her
// art from the pack, and the pick syncs; turned off, the notice goes and the picker no longer lists her. The collab
// pack's official effects (/data/local-fx-collab.json) resolve in the page's effects library only while it is on.
//
//   SP_E2E=1 node --test test/ui/collab-ops.e2e.test.js
//
// Screenshots: test/e2e/out/collab-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const ASH = 'char_456_ash';
const SLOT = 'chess_char_6_diy1_a';
const SLOT2 = 'chess_char_6_diy2_a';
const PICKER = '[data-testid="diy-picker"]';
const HOLD = '[data-testid="dialog-hold-ok"]';
const collabOn = (c) => c.page.evaluate(() => globalThis.__SP__.store.get().room?.experimental?.collabOps === true);
/** The page's own effects library (a fresh one, with the page's cosmetic layers): does 灰烬's flashbang hit resolve? */
const collabFx = (c) => c.page.evaluate(async () => {
  const { cosmetics } = await import('/js/cosmetics.js');
  const { FxLibrary } = await import('/js/render/vfx/library.js');
  const lib = new FxLibrary({});
  const idx = await lib.index();
  const desc = await lib.descriptor('ash_buff_01_hit');
  return { layer: !!cosmetics.collab, has: lib.has('ash_buff_01_hit'), unit: !!idx?.units?.char_456_ash, desc: !!desc };
});

describe('联动干员 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('warning with a 5 s hold → notices for everybody → the pack loads → a collab pick in 自选; off again', { timeout: 5 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'collab' });
    const guest = new Client(P, srv.base, 'guest', { prefix: 'collab' });
    const pack = { host: 0, guest: 0 };
    let fxList = 0;
    try {
      await host.open();
      host.page.on('request', (r) => { if (r.url().includes('/data/assets-collab.json')) pack.host++; if (r.url().includes('/data/local-fx-collab.json')) fxList++; });
      await host.enter('联动房主');
      const { code } = await host.createCoop();
      await guest.open();
      guest.page.on('request', (r) => { if (r.url().includes('/data/assets-collab.json')) pack.guest++; });
      await guest.enter('联动队友');
      await guest.click('.hub-tile', '密钥加入');
      await guest.click('.hub-dialog .join-row input');
      await guest.page.keyboard.type(code);
      await guest.click('.join-row button', '加入同盟');
      await guest.waitFor((s) => s.room?.code === code, 'guest in the room', 20000);
      await sleep(800);
      assert.deepEqual(pack, { host: 0, guest: 0 }, 'no page fetches the pack in a room without it');
      assert.deepEqual(await collabFx(host), { layer: false, has: false, unit: false, desc: false }, 'no collab effect without it');
      assert.equal(fxList, 0, 'the collab effects list is not fetched');

      // 规则: the switch, its warning; 不开启 keeps it off
      await host.click('.rs-exp');
      await host.page.waitForSelector('#experimental-collab', { visible: true, timeout: 10000 });
      await host.page.click('#experimental-collab');
      await host.page.waitForSelector('[data-testid="collab-warning"]', { visible: true, timeout: 5000 });
      assert.deepEqual(await host.page.$eval(HOLD, (b) => ({ disabled: b.disabled, left: Number(b.dataset.left) })), { disabled: true, left: 5 });
      assert.equal(await host.page.$eval('#experimental-collab', (e) => e.checked), false, 'the switch stays off behind the warning');
      await sleep(800); // past the dialog's opening animation
      const onTop = await host.page.evaluate(() => {
        const r = document.querySelector('[data-testid="collab-warning"]').getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!el?.closest('.collab-dialog');
      });
      assert.ok(onTop, 'the warning lies over the settings dialog');
      await host.shot('warning');
      await host.click('.modal__actions button', '不开启');
      await host.page.waitForSelector('[data-testid="collab-warning"]', { hidden: true, timeout: 5000 });
      assert.equal(await host.page.$eval('#experimental-collab', (e) => e.checked), false);
      assert.equal(await collabOn(host), false);

      // again: a press during the hold does nothing; after 5 s 开启 works
      await host.page.click('#experimental-collab');
      await host.page.waitForSelector(HOLD, { visible: true, timeout: 5000 });
      const t0 = Date.now();
      await sleep(1500);
      await host.page.$eval(HOLD, (b) => b.click());
      await sleep(300);
      assert.equal(await collabOn(host), false, 'held: nothing sent');
      assert.equal(await host.page.$eval(HOLD, (b) => b.disabled), true);
      await host.page.waitForFunction((sel) => document.querySelector(sel)?.disabled === false, { timeout: 8000 }, HOLD);
      const held = Date.now() - t0;
      assert.ok(held >= 3000, `the hold lasted ${held} ms after the first 1.5 s were already counted`);
      await host.click(HOLD);
      await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.collabOps === true, { timeout: 8000 });
      assert.equal(await host.page.$eval('#experimental-collab', (e) => e.checked), true);
      await host.click('.room-settings-modal .modal__actions button', '完成');

      // both see the notice; both pages fetch the pack once
      for (const c of [host, guest]) await c.page.waitForSelector('.rs-collab [data-testid="collab-notice"]', { visible: true, timeout: 8000 });
      for (let i = 0; i < 40 && (!pack.host || !pack.guest); i++) await sleep(150);
      assert.ok(pack.host >= 1 && pack.guest >= 1, `the pack was fetched: ${JSON.stringify(pack)}`);
      await guest.shot('notice');
      await host.page.waitForFunction(() => import('/js/cosmetics.js').then((m) => !!m.cosmetics.collab), { timeout: 8000 });
      assert.deepEqual(await collabFx(host), { layer: true, has: true, unit: true, desc: true }, '灰烬\'s effect resolves from the pack');
      assert.ok(fxList >= 1, 'the collab effects list was fetched');
      assert.equal(await guest.page.evaluate(() => globalThis.__SP__.store.get().room?.experimental?.collabOps), true);

      // the guest's 自选: 灰烬 is offered, tagged, drawn from the pack; the pick syncs
      await guest.click('.rs-loadout');
      await guest.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await guest.click('.lo .lo-tab[data-tab="diy"]');
      await guest.page.waitForSelector('.diy [data-testid="collab-notice"]', { visible: true, timeout: 8000 });
      await guest.page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
      await guest.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
      await guest.page.waitForSelector(`${PICKER} .diy-opt[data-char="${ASH}"] [data-testid="diy-collab-tag"]`, { timeout: 8000 });
      await guest.page.waitForSelector(`${PICKER} [data-testid="collab-notice"]`, { visible: true, timeout: 5000 });
      const art = await guest.page.$eval(`${PICKER} .diy-opt[data-char="${ASH}"]`, (e, id) => {
        e.scrollIntoView({ block: 'center' });
        return [...e.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').find((s) => s.includes(id)) || '';
      }, ASH);
      assert.match(art, /\/collab\//, `her avatar comes from the pack: ${art}`);
      await guest.page.$eval(`${PICKER} .diy-opt[data-char="${ASH}"]`, (e) => (e.querySelector('.diy-opt__pick') ?? e).click());
      await guest.page.waitForSelector(`${PICKER} .lo-skill[data-skill="2"]`, { visible: true, timeout: 5000 });
      await guest.page.click(`${PICKER} .lo-skill[data-skill="2"]`);
      await guest.shot('picker');
      await guest.click('[data-testid="diy-confirm"]');
      await guest.page.waitForFunction((slot, id) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.dataset.char === id, { timeout: 4000 }, SLOT, ASH);
      await guest.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 8000 });
      await guest.page.keyboard.press('Escape');
      await guest.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 3000 });

      // off: at once, no warning; the notice goes, the picker no longer lists her
      await host.click('.rs-exp');
      await host.page.waitForSelector('#experimental-collab', { visible: true, timeout: 10000 });
      await host.page.click('#experimental-collab');
      await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.collabOps !== true, { timeout: 8000 });
      assert.equal(await host.page.$('[data-testid="collab-warning"]'), null, 'turning it off asks nothing');
      await host.click('.room-settings-modal .modal__actions button', '完成');
      await guest.page.waitForSelector('[data-testid="collab-notice"]', { hidden: true, timeout: 8000 });
      await host.page.waitForFunction(() => import('/js/cosmetics.js').then((m) => !m.cosmetics.collab), { timeout: 8000 });
      assert.deepEqual(await collabFx(host), { layer: false, has: false, unit: false, desc: false }, 'gone again with it off');
      await guest.click('.rs-loadout');
      await guest.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await guest.click('.lo .lo-tab[data-tab="diy"]');
      await guest.page.waitForSelector(`.diy-slot[data-slot="${SLOT2}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
      await guest.click(`.diy-slot[data-slot="${SLOT2}"] .diy-slot__fill`);
      await guest.page.waitForSelector(`${PICKER} .diy-opt`, { timeout: 8000 });
      assert.equal(await guest.page.$(`${PICKER} .diy-opt[data-char="${ASH}"]`), null, 'not offered with it off');
      await guest.shot('off');
      for (const c of [host, guest]) assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), [], c.label);
    } finally {
      await guest.close();
      await host.close();
      await srv.stop();
    }
  });
});
