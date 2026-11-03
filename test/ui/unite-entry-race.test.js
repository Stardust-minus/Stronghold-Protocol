// 联防 entry race (rel26, the owner's report of 2026-11-02: 「联防的时候，干员有概率变成红色水滴」 — not every time; the
// droplet attacks normally but cannot be clicked: its snapshots and attack events arrive, its 'spawn' UnitInfo never did).
// A 联防 local replica is shown at tick 0 (battle/runner.js show), before Battle.start deploys anyone (sim lifecycle.js:
// the first step), so its m.field lists no unit and every operator's UnitInfo comes from the 'spawn' events of the
// opening. Until the game screen enters the field (screens/game.js, a React effect after the store change — late on a
// slow phone or while the field is built) those events wait in the early buffer, which used to drop its OLDEST tuples
// past 1500: the opening spawns. Here the real runner plays a real 联防 b.start (a client-combat harness match) as a
// display replica, a consumer that buffers like game.js enters it k frames after the show, at varying offsets, and every
// living unit of every later snapshot must be known (else render/app.js createUnknown draws the red placeholder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import { keepEarly, trimEarly, EARLY_MAX } from '../../public/js/screens/game/early.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch } from '../match/harness.js';

const DS = new DataSource(DATA, null);

/** A real 联防 b.start: a client-combat match played until a 联防 opens (bots fight, the human leaks). */
function uniteStart() {
  for (const seed of [7301, 7302, 7303, 7304, 7305, 7306]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed, captureFrames: false, clientCombat: true, clients: false });
    h.autoHumans();
    h.m.start();
    h.run(() => h.ended != null || h.m.phase === PHASE.UNITE || h.m.round > 9, { maxSteps: 3e6 });
    const msg = h.m.phase === PHASE.UNITE ? h.allTo('p_0', 'b.start').reverse().find((m) => m.kind === 'unite') : null;
    h.m.dispose();
    if (msg) return msg;
  }
  return null;
}

function fakeNet() {
  const handlers = new Map();
  return {
    sent: [],
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); return () => handlers.get(t).delete(fn); },
    emit(t, msg) { for (const fn of handlers.get(t) || []) fn({ t, ...msg }); },
    send(t, fields) { this.sent.push({ ...fields, t }); return true; },
    request(t, fields) { this.sent.push({ ...fields, t }); return Promise.resolve({ t: 'ok' }); },
  };
}

/**
 * The real runner showing `start` as a display replica; a game.js-like consumer enters k frames after the show with the
 * buffer policy `trim`, then counts the living snapshot units it has no UnitInfo for.
 */
async function play(start, k, trim, frames = 900, { reenterAt = null, reenter = 'stale' } = {}) {
  let t = 1000;
  const queue = [];
  const net = fakeNet();
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc: { hidden: false, addEventListener() {} }, now: () => t,
    raf: (fn) => { queue.push(fn); return queue.length; }, caf: () => {},
    setInterval: () => 0, clearInterval: () => {},
    loadSim: async () => ({ spec: specMod, ds: DS }), logger: { error() {}, warn() {}, info() {}, debug() {} }, combatMetrics: false,
  });
  const fid = start.fieldId;
  const evBuf = new Map();
  let meta = null, shownAt = null, frame = 0, infos = null, peak = 0;
  const unknown = new Map();
  const attacks = new Set();
  let pendingMeta = false;
  runner.on('field', (m) => { evBuf.set(m.fieldId, []); meta = m; shownAt ??= frame; if (infos) { infos = null; pendingMeta = true; } });
  runner.on('ev', (m) => {
    if (!infos) {
      const buf = evBuf.get(m.fieldId) || [];
      for (const e of m.ev) if (keepEarly(e)) buf.push(e);
      trim(buf);
      peak = Math.max(peak, buf.length);
      evBuf.set(m.fieldId, buf);
      return;
    }
    for (const e of m.ev) {
      if (e[0] === 'spawn') infos.set(e[1].id, e[1]);
      else if (e[0] === 'atk' && !infos.has(e[1])) attacks.add(e[1]);
    }
  });
  runner.on('snap', (s) => {
    if (!infos || s.fieldId !== fid) return;
    for (const u of s.units) if (u[3] > 0 && !infos.has(u[0])) unknown.set(u[0], frame);
  });
  net.emit('b.start', { ...start, authoritative: false, local: true, watch: true, elapsed: 0 });
  for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); for (const fn of queue.splice(0)) fn(t); }
  assert.ok(meta, 'shown');
  const opening = meta;
  for (frame = 0; frame < frames; frame++) {
    if (infos && reenterAt != null && frame === reenterAt) {
      // the screen resets and enters the field again (a relay key arriving after the show): 'stale' = from the stored
      // opening meta, as before the fix; 'reshow' = the runner's fresh meta (the fix's request)
      if (reenter === 'stale') { infos = new Map((opening.units || []).map((u) => [u.id, u])); }
      else runner.reshow();
    }
    if (pendingMeta) {
      pendingMeta = false;
      infos = new Map((meta.units || []).map((u) => [u.id, u]));
      for (const e of evBuf.get(fid) || []) if (e[0] === 'spawn') infos.set(e[1].id, e[1]);
      evBuf.delete(fid);
    }
    if (!infos && frame - shownAt >= k) {
      // the enter effect: the field meta's units, then the early buffer (spawns among them)
      infos = new Map((meta.units || []).map((u) => [u.id, u]));
      for (const e of evBuf.get(fid) || []) if (e[0] === 'spawn') infos.set(e[1].id, e[1]);
      evBuf.delete(fid);
    }
    t += 1000 / 60;
    for (const fn of queue.splice(0)) fn(t);
  }
  runner.dispose?.();
  return { unknown, peak, attacks, metaUnits: (opening.units || []).length };
}

const legacy = (buf) => { if (buf.length > EARLY_MAX) buf.splice(0, buf.length - EARLY_MAX); };

test('联防 entered at any offset after the show: every unit on screen is known (trimEarly keeps the opening spawns)', { timeout: 600000 }, async (t) => {
  const start = uniteStart();
  if (!start) { t.skip('no 联防 within the seeds (harness)'); return; }
  const ops = start.spec.players.reduce((n, p) => n + (p.units || []).length, 0);
  assert.ok(ops >= 4, `a 联防 with operators (${ops})`);
  const rows = [];
  for (const k of [0, 1, 2, 5, 15, 60, 240, 600]) {
    const now = await play(start, k, trimEarly);
    rows.push({ k, metaUnits: now.metaUnits, peak: now.peak, unknown: now.unknown.size });
    assert.equal(now.metaUnits, 0, 'shown at tick 0: the meta lists nobody (Battle.start deploys on the first step)');
    assert.equal(now.unknown.size, 0, `entered ${k} frames after the show: unknown ${[...now.unknown.keys()]}`);
  }
  // the old cut: a late enough entry of a busy 联防 loses opening spawns once the buffer passes 1500 tuples
  const old = await play(start, 600, legacy);
  rows.push({ k: 600, policy: 'legacy', peak: old.peak, unknown: old.unknown.size });
  t.diagnostic(JSON.stringify(rows));
  if (old.peak >= EARLY_MAX) assert.ok(old.unknown.size > 0, 'the legacy cut drops opening spawns');
});

test('a re-entry of the 联防 from its stored opening meta loses every unit (they fight on, unknown); a fresh meta keeps them', { timeout: 600000 }, async (t) => {
  const start = uniteStart();
  if (!start) { t.skip('no 联防 within the seeds (harness)'); return; }
  const rows = [];
  for (const at of [20, 60, 120]) {   // inside the opening of the harness 联防 (it is over within ~5 s)
    const stale = await play(start, 2, trimEarly, 700, { reenterAt: at, reenter: 'stale' });
    const fresh = await play(start, 2, trimEarly, 700, { reenterAt: at, reenter: 'reshow' });
    rows.push({ at, stale: stale.unknown.size, staleAttacking: stale.attacks.size, fresh: fresh.unknown.size });
    assert.ok(stale.unknown.size > 0, `re-entered from the opening meta at frame ${at}: units without UnitInfo`);
    assert.equal(fresh.unknown.size, 0, `re-entered from a fresh meta at frame ${at}: ${[...fresh.unknown.keys()]}`);
  }
  t.diagnostic(JSON.stringify(rows));
});
