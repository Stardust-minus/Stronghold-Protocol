// Browser check of the local display replicas in a room of an older official version (server-run combat, the version
// host's own combat Workers: server/match/host/entry.js options.combatWorkers; DESIGN docs/design/network.md "Local
// display replicas"): the page runs the fields on the version's sim, the unit card reads 实时 during a battle, the Worker's
// digests agree through a normal battle and the Final Assault (its pool record, b.ext), nothing falls back to the stream.
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/version-local-replica.e2e.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const MODULE = fileURLToPath(new URL('../e2e/versionMatch.mjs', import.meta.url));
// VERSIONS_UNDER_TEST=<id,…> narrows a run; the two have different rule generations (第一期 / 第二期)
const IDS = (process.env.VERSIONS_UNDER_TEST || 'act1autochess,act2autochess@V2_1').split(',').map((x) => x.trim()).filter(Boolean);

/** The runner's replicas in a page and the field on screen. */
const replicas = (c) => c.page.evaluate(() => {
  const r = globalThis.__SP_RUNNER__;
  const list = [...(r?._entries?.values() || [])].map((e) => ({ kind: e.kind, fieldId: e.fieldId, replica: !!e.replica, dropped: !!e.dropped, cs: e.spec?.cs ?? null,
    version: e.spec?.version ?? null, tick: e.battle?.tickCount ?? null, synced: e.synced, replay: !!e.replay, to: e.replay?.to ?? null, poolHp: e.replay?.hp ?? null, finished: !!e.battle?.finished }));
  const s = globalThis.__SP__.store.get();
  return { list, field: s.match.field ? { fieldId: s.match.field.fieldId, kind: s.match.field.kind, local: !!s.match.field.local } : null, phase: s.match.public?.phase, round: s.match.public?.round,
    roomCs: s.room?.content?.cs ?? null, tag: document.querySelector('.dpanel .dstats__tag')?.textContent ?? null };
});

/** Click an own unit of the battle on screen: its card. */
async function openCard(c) {
  let seen = null;
  for (const end = Date.now() + 15000; Date.now() < end; await sleep(300)) {
    seen = await c.page.evaluate(() => {
      const s = globalThis.__SP__.store.get();
      // (a local field's meta lists no units: they are the replica's)
      const units = [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].flatMap((e) => e.battle?.units || []);
      return { me: s.me.playerId, units: units.length, points: units.filter((u) => u.ownerId === s.me.playerId && u.alive).map((u) => {
        const r = globalThis.__SP_VIEW__.pieceScreenRect(u.id);
        return r ? { x: r.left + r.width / 2, y: r.top + r.height * 0.6 } : null;
      }).filter(Boolean) };
    });
    for (const pt of seen.points) {
      await c.page.mouse.click(pt.x, pt.y);
      if (await c.page.waitForSelector('.dpanel .dstats__tag', { timeout: 500 }).catch(() => null)) return;
    }
  }
  await c.shot('no-card');
  assert.fail(`no unit card opened: ${JSON.stringify(seen).slice(0, 600)}`);
}

describe('an older version\'s room as local display replicas (server-run combat, its host\'s Workers)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  for (const version of IDS) {
    test(`${version}: 实时 on the card, digests agree through a battle and the Final Assault`, { timeout: 8 * 60 * 1000 }, async () => {
      const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2, verbose: true }, env: { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10',
        SP_VERSION_MATCH_MODULE: MODULE, ...(process.env.SP_VERSION_COMBAT_WORKERS ? { SP_VERSION_COMBAT_WORKERS: process.env.SP_VERSION_COMBAT_WORKERS } : {}) } });
      const P = (await import('puppeteer-core')).default;
      const c = new Client(P, srv.base, version.replace(/\W/g, '_'), { prefix: 'version-local', w: 1280, h: 720, prefs: {} });
      try {
        await c.open();
        await c.enter('凯尔希');
        await c.click('[data-testid="version-switch"]');
        await c.click(`.verpick__pick[data-version="${version}"]`);
        await c.page.waitForFunction((v) => document.querySelector('[data-testid="version-switch"]')?.dataset.version === v, { timeout: 30000 }, version);
        await c.createSolo('标准模拟');
        await c.waitFor((s) => !!s.room, 'solo room');
        if (!(await c.st()).phase) await c.roomStart({ timeout: 20000 });
        await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
        await c.settled('.brief-go');
        await c.click('.brief__foot .btn--primary', '准备就绪');
        await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
        await c.click('.dband', null, { nth: 0 });
        await c.click('.draft-detail__btns .btn--primary', '确认选择');
        await c.waitFor((s) => s.phase === 'PREP' && !s.ready, 'the round before the boss', 60000);
        await sleep(1500);
        await c.page.evaluate(() => globalThis.__SP__.net.request('g.ready', { ready: true }));

        // the normal battle
        await c.waitFor((s) => s.phase === 'COMBAT', 'normal battle', 60000);
        await c.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.battle), { timeout: 30000 });
        await openCard(c);
        await sleep(6000);
        const normal = await replicas(c);
        await c.shot(`${version.replace(/\W/g, '_')}-normal`);
        console.log(version, 'normal', JSON.stringify(normal));
        const n = normal.list.find((e) => e.kind === 'normal');
        assert.ok(n, JSON.stringify(normal));
        assert.deepEqual([n.replica, n.dropped, n.cs, n.version], [true, false, normal.roomCs, version], JSON.stringify(n));
        assert.equal(normal.field?.local, true, 'the field on screen is the replica');
        assert.equal(normal.tag, '实时', 'the card');
        assert.ok(n.finished || n.synced >= 2, `Worker digests compared and equal (${n.synced})`);

        // the Final Assault
        await c.page.keyboard.press('Escape');
        const fight = async () => {
          const s = await c.st();
          if (s.phase === 'PREP' && !s.ready) await c.page.evaluate(() => globalThis.__SP__.net.request('g.ready', { ready: true })).catch(() => {});
          return s.phase === 'FINAL_ASSAULT';
        };
        for (const end = Date.now() + 120000; !(await fight());) { assert.ok(Date.now() < end, 'reached the Final Assault'); await sleep(500); }
        await c.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.kind === 'boss' && e.replay && e.battle), { timeout: 30000 });
        const first = await replicas(c);
        await sleep(9000);
        const later = await replicas(c);
        await c.shot(`${version.replace(/\W/g, '_')}-boss`);
        console.log(version, 'boss', JSON.stringify(later));
        const b = later.list.find((e) => e.kind === 'boss');
        assert.ok(b, JSON.stringify(later));
        assert.deepEqual([b.replica, b.replay, b.dropped, b.cs], [true, true, false, later.roomCs], JSON.stringify(b));
        assert.equal(later.field?.local, true);
        assert.ok(b.tick <= b.to, `never past the record (${b.tick} > ${b.to})`);
        assert.ok(b.finished || b.tick > first.list.find((e) => e.kind === 'boss').tick + 200, 'it advanced');
        assert.ok(b.synced >= 3, `Worker digests compared and equal (${b.synced})`);

        const fallbacks = srv.logs.filter((l) => l.includes('local replica → stream'));
        assert.deepEqual(fallbacks, [], 'nothing fell back to the stream');
        assert.ok(srv.logs.some((l) => l.includes('combat pool ready')), srv.logs.slice(-20).join('\n'));
        assert.deepEqual(problemsOf([c]), []);
      } finally {
        if (c.problems.length) console.log(c.label, c.problems.slice(0, 20).join('\n'));
        console.log(srv.logs.filter((l) => /local replica|\[versions\]|\[host\]/.test(l)).slice(-12).join('\n'));
        await c.close();
        await srv.stop();
      }
    });
  }
});
