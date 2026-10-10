// Live operator stats (user playtest #4 item 7 — the detail card showed the fixed record numbers): g.unitStats answers
// m.unitStats { seq, round, units } with the stats every unit of the player's board starts its next battle with — the
// real battle input (equipment, bonds / layers, 特质, band and 机变 effects, the onBattleStart meta) built into a Battle
// that is started and read, never stepped (server/match/match/intents.js unitStats); the shape is shared/protocol.js
// unitStatsEntry (also the browser runner's live battle stats, test/match/runner.test.js). The preview changes nothing
// of the match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { validateC2S, unitStatsEntry, S2C } from '../../shared/protocol.js';
import { Battle } from '../../server/sim/Battle.js';
import { Unit } from '../../server/sim/units.js';
import { DIE_ANIM_TIME } from '../../server/sim/constants.js';
import { DeadBattle, FieldRunner } from '../../server/match/fields.js';
import { makeMatch, give, giveItem, chessOfTier, legalTileFor } from './harness.js';

/** 阿戈尔重刃: ATK +40 % (its own multiplier), attack speed −10 (data/items.json). */
const BLADE = 'chess_item_3_07_e_a';
/** 双模机械臂: ATK +30 % (a second, different item: both apply — two equal ones would merge into the hand). */
const ARM = 'chess_item_5_03_e_a';

/** Solo PREP R1 with one chess on an empty board carrying 阿戈尔重刃 (equipped through g.equip). */
function setup(seed = 21, opts = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed, ...opts }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  ps.recompute();
  const id = chessOfTier(1, (c) => c.position === 'MELEE' && !m.gd.placeableTokens(c.chessId).length).find((x) => m.pool.has(x));
  const carrier = give(m, ps, id, 'board', legalTileFor(m, ps, id));
  const item = giveItem(m, ps, BLADE);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: item.uid, targetUid: carrier.uid }), { ok: true });
  return { h, m, ps, carrier };
}

test('protocol: g.unitStats { seq? } and g.bandFocus { bandId? } validate; m.unitStats is a known push', () => {
  assert.equal(validateC2S({ t: 'g.unitStats' }), null);
  assert.equal(validateC2S({ t: 'g.unitStats', seq: 12 }), null);
  assert.notEqual(validateC2S({ t: 'g.unitStats', seq: -1 }), null);
  assert.notEqual(validateC2S({ t: 'g.unitStats', seq: 1.5 }), null);
  assert.equal(validateC2S({ t: 'g.bandFocus' }), null, 'no band = clear the highlight');
  assert.equal(validateC2S({ t: 'g.bandFocus', bandId: null }), null);
  assert.equal(validateC2S({ t: 'g.bandFocus', bandId: 'band_bldsk' }), null);
  assert.notEqual(validateC2S({ t: 'g.bandFocus', bandId: 'a b' }), null);
  assert.ok(S2C.includes('m.unitStats'));
  assert.equal(validateC2S({ t: 'g.choice', idx: 0 }), null);
  assert.equal(validateC2S({ t: 'g.choice', idx: 2, choiceId: 'seed-2.choice.12' }), null);
  for (const choiceId of [null, '', 'a b', 12, 'a'.repeat(65)]) {
    assert.notEqual(validateC2S({ t: 'g.choice', idx: 0, choiceId }), null);
  }
});

test('unitStatsEntry: effective stats next to the base, rounded for display; the interval from bat / aspd when absent', () => {
  const u = { id: 3, uid: 44, defId: 'chess_x', hp: 812.6, alive: true, base: { maxHp: 1000, atk: 300, def: 100, res: 10, aspd: 100, bat: 1.2, blockCnt: 2, moveSpeed: 0 } };
  const e = unitStatsEntry(u, { maxHp: 1250.4, atk: 420.49, def: 90, res: 12.34, interval: 1.0833333, blockCnt: 3, moveSpeed: 0 });
  assert.deepEqual(e, {
    id: 3, uid: 44, defId: 'chess_x', hp: 813, alive: true,
    maxHp: 1250, atk: 420, def: 90, res: 12.3, interval: 1.08, blockCnt: 3, moveSpeed: 0,
    base: { maxHp: 1000, atk: 300, def: 100, res: 10, interval: 1.2, blockCnt: 2, moveSpeed: 0 },
    silenced: false,
  });
  const plain = unitStatsEntry(u);
  assert.equal(plain.atk, 300, 'no aggregated stats: the base');
  assert.equal(plain.interval, 1.2);
  assert.equal(unitStatsEntry(null).maxHp, 0, 'never throws');
  assert.equal(unitStatsEntry({ base: { bat: 0 } }).interval, null, 'no attack');
});

test('snapshot unitStats: opt-in exposes real effective/base stats, buffs, debuffs and removal without changing tuples', (t) => {
  const { m, ps, carrier } = setup(24);
  t.after(() => m.dispose());
  const b = m.newBattle(m._normalOpts(ps));
  b.start();
  const u = b.allyUnits.find((x) => x.uid === carrier.uid);
  const read = () => {
    const legacy = b.snapshot();
    assert.equal(Object.hasOwn(legacy, 'unitStats'), false, 'local/browser snapshots keep their old shape');
    const { unitStats, ...snap } = b.snapshot({ includeUnitStats: true });
    assert.deepEqual(snap, legacy, 'the nine-field tuples and every old readout stay unchanged');
    assert.deepEqual(unitStats.map((x) => x.id), snap.units.map((x) => x[0]));
    assert.ok(snap.units.every((x) => x.length === 9));
    const entry = unitStats.find((x) => x.uid === carrier.uid);
    assert.deepEqual(entry, unitStatsEntry(u, u._s), 'reuse the public DTO and the tuple-computed cache');
    return entry;
  };
  const initial = read();
  assert.ok(initial.atk > initial.base.atk, 'equipped 阿戈尔重刃 is already effective');
  assert.ok(initial.interval > initial.base.interval, 'the item also lowers attack speed');
  b.addBuff(u, { key: 'test:boost', mods: { atkPct: 0.5, defPct: 0.3, hpPct: 0.25, aspd: 30 } });
  const boosted = read();
  assert.ok(boosted.atk > initial.atk && boosted.def > initial.def && boosted.maxHp > initial.maxHp);
  assert.ok(boosted.interval < initial.interval);
  assert.deepEqual(boosted.base, initial.base, 'the cultivated own numbers exclude temporary buffs');
  b.addBuff(u, { key: 'test:debuff', mods: { atkMul: 0.25, defMul: 0.5, aspd: -60 }, flags: { silence: true } });
  const reduced = read();
  assert.ok(reduced.atk < initial.atk && reduced.def < initial.def && reduced.interval > initial.interval);
  assert.equal(reduced.silenced, true);
  assert.deepEqual(reduced.base, initial.base);
  assert.equal(b.removeBuff(u, 'test:debuff'), 1);
  assert.deepEqual(read(), boosted, 'removing a debuff restores the buffed view');
  assert.equal(b.removeBuff(u, 'test:boost'), 1);
  assert.deepEqual(read(), initial, 'removing both restores the equipped start stats');
});

test('snapshot unitStats: exact tuple visibility/death window, public DTO copies and no extra lazy getter reads', () => {
  const make = () => {
    const b = new Battle({ seed: 44, fieldId: 'privacy', content: 'none', autoFinish: false });
    b.time = 10;
    const reads = new Map();
    const getStats = Object.getOwnPropertyDescriptor(Unit.prototype, 's').get;
    const add = (id, side, state = {}) => {
      const u = new Unit({ id, uid: side === 'ally' ? id + 100 : null, side, kind: side === 'ally' ? 'op' : 'enemy',
        ownerId: 'p_0', defId: 'test_unit', base: { maxHp: 1000, atk: 300, def: 100, res: 20, bat: 1.2 } });
      u.deployed = true;
      u.liveRangeGrid = [[0, 0], [0, 1]];
      u.mem.privateMarker = 'not-a-public-detail';
      Object.assign(u, state);
      Object.defineProperty(u, 's', { configurable: true, get() {
        reads.set(id, (reads.get(id) || 0) + 1);
        assert.ok(![4, 5, 6, 7].includes(id), `unlisted ${id} must not read lazy stats`);
        return getStats.call(this);
      } });
      b.units.push(u);
      if (side === 'ally') b.allyUnits.push(u);
      return u;
    };
    const live = add(1, 'ally');
    live.cultMul = { atk: 1.2, def: 1.2, hp: 1.2 };
    b.addBuff(live, { key: 'test:cache', mods: { hpPct: 0.25, atkPct: 0.5 }, data: { privateMarker: 'raw-buff' } });
    add(2, 'enemy');
    add(3, 'ally', { alive: false, deployed: false, deathAt: 10 - DIE_ANIM_TIME / 2 });
    add(4, 'ally', { hidden: true });
    add(5, 'enemy', { hidden: true, alive: false, deathAt: 9.9 });
    add(6, 'ally', { deployed: false });
    add(7, 'enemy', { alive: false, deployed: false, deathAt: 10 - DIE_ANIM_TIME - 0.01 });
    const dying = add(8, 'enemy', { alive: false, deployed: false, deathAt: 9.9 });
    // A unit without a computed cache must use its base DTO, not introduce a detail-only s read.
    const fallback = add(9, 'ally');
    const s = getStats.call(fallback);
    fallback._s = null;
    Object.defineProperty(fallback, 's', { configurable: true, get() { reads.set(9, (reads.get(9) || 0) + 1); return s; } });
    return { b, reads, live, dying, fallback };
  };
  const plain = make(), detailed = make();
  const legacy = plain.b.snapshot();
  const { unitStats, ...snap } = detailed.b.snapshot({ includeUnitStats: true });
  assert.deepEqual(snap, legacy);
  assert.deepEqual([...detailed.reads], [...plain.reads], 'detail DTO construction never adds an s read');
  assert.deepEqual(unitStats.map((x) => x.id), [1, 2, 3, 8, 9], 'only the exact tuple-selected units');
  assert.deepEqual(unitStats.map((x) => x.id), snap.units.map((x) => x[0]));
  assert.deepEqual(unitStats[0], unitStatsEntry(detailed.live, detailed.live._s));
  assert.equal(unitStats[0].base.maxHp, 1200);
  assert.equal(unitStats[0].maxHp, 1500);
  assert.equal(unitStats[2].alive, false, 'recent death animation remains visible');
  assert.equal(unitStats[3].range, undefined, 'enemy targeting grids are not exposed');
  assert.equal(unitStats[4].atk, unitStats[4].base.atk, 'null cache falls back to base');
  assert.equal(detailed.fallback._s, null);
  const publicKeys = ['id', 'uid', 'defId', 'hp', 'alive', 'maxHp', 'atk', 'def', 'res', 'interval', 'blockCnt', 'moveSpeed', 'base', 'range', 'dir', 'silenced'];
  for (const entry of unitStats) assert.ok(Object.keys(entry).every((key) => publicKeys.includes(key)), 'only whitelisted helper fields');
  assert.equal(JSON.stringify(unitStats).includes('privateMarker'), false, 'no raw buffs, mem or Unit serialization');
  unitStats[0].range[0][0] = 99;
  unitStats[0].base.atk = -1;
  unitStats[0].atk = -1;
  assert.deepEqual(detailed.live.liveRangeGrid[0], [0, 0], 'range DTO is detached');
  assert.equal(detailed.live.base.atk, 300);
  assert.ok(detailed.live._s.atk > 300);
  for (const h of [plain, detailed]) {
    h.b.time = 10 + DIE_ANIM_TIME;
    h.dying.hidden = true;
  }
  const laterLegacy = plain.b.snapshot();
  const later = detailed.b.snapshot({ includeUnitStats: true });
  assert.deepEqual(later.unitStats.map((x) => x.id), later.units.map((x) => x[0]));
  assert.deepEqual(later.unitStats.map((x) => x.id), [1, 2, 9], 'death-window expiry and hiding both remove stale details');
  const { unitStats: _later, ...laterSnap } = later;
  assert.deepEqual(laterSnap, laterLegacy);
});

test('snapshot unitStats: empty real and failed battles carry [] only when opted in', () => {
  for (const b of [new Battle({ content: 'none' }), new DeadBattle({ fieldId: 'failed' })]) {
    const legacy = b.snapshot();
    assert.equal(Object.hasOwn(legacy, 'unitStats'), false);
    assert.deepEqual(b.snapshot({ includeUnitStats: false }), legacy);
    const { unitStats, ...snap } = b.snapshot({ includeUnitStats: true });
    assert.deepEqual(unitStats, []);
    assert.deepEqual(snap, legacy);
  }
});

test('snapshot unitStats: opted-in seeded combat preserves state, HP, events, timing, RNG and full result', (t) => {
  const { m, ps } = setup(25);
  t.after(() => m.dispose());
  const opts = { ...m._normalOpts(ps), timeLimit: 8 };
  const [plain, detailed] = [m.newBattle(opts), m.newBattle(opts)];
  const state = (b) => ({ time: b.time, ticks: b.tickCount, rng: b.rng.state(), finished: b.finished,
    units: b.units.map((u) => ({ id: u.id, hp: u.hp, dirty: u._dirty, s: u._s, atkCd: u.atkCd, sp: u.skill?.sp,
      buffs: u.buffs.map((x) => ({ key: x.key, timeLeft: x.timeLeft, stacks: x.stacks })) })) });
  for (let i = 0; i < 300 && !plain.finished; i++) {
    plain.step(); detailed.step();
    const legacy = plain.snapshot();
    const { unitStats, ...snap } = detailed.snapshot({ includeUnitStats: true });
    assert.deepEqual(snap, legacy);
    assert.deepEqual(unitStats.map((x) => x.id), snap.units.map((x) => x[0]));
    assert.deepEqual(state(detailed), state(plain));
    assert.deepEqual(detailed.drainEvents(), plain.drainEvents());
  }
  assert.equal(plain.finished, true, 'real combat reached a terminal state');
  assert.deepEqual(detailed.result(), plain.result());
  assert.equal(detailed.errorCount, 0);
});

test('snapshot unitStats: inline first-tick and reconnect metadata retain the frozen effective/base cache; periodic snapshots stay compact', (t) => {
  const { h, m, carrier } = setup(26, { instant: false });
  t.after(() => m.dispose());
  m.startCombat();
  assert.ok(m.runner instanceof FieldRunner);
  const initial = h.lastTo('p_0', 'b.snap');
  assert.deepEqual(initial.units, [], 'initial undeployed field is a complete empty snapshot');
  assert.equal(Object.hasOwn(initial, 'unitStats'), false, 'snapshots never duplicate the panel cache');
  m.runner._tick();
  const opening = h.lastTo('p_0', 'm.field');
  const u = m.fields[0].battle.allyUnits.find((x) => x.uid === carrier.uid);
  const entry = opening.unitStats.find((x) => x.uid === carrier.uid);
  assert.deepEqual(entry, unitStatsEntry(u, u._s));
  assert.ok(entry.atk > entry.base.atk);
  const cached = structuredClone(opening.unitStats);
  for (let i = 0; i < 2; i++) m.runner._tick();
  const periodic = h.lastTo('p_0', 'b.snap');
  assert.equal(Object.hasOwn(periodic, 'unitStats'), false);
  assert.equal(h.allTo('p_0', 'm.field').filter(msg => Array.isArray(msg.unitStats)).length, 1, 'the running field sends the first-tick cache once');
  m.onDisconnect('p_0');
  const before = h.sent.length;
  m.onReconnect('p_0');
  const frames = h.sent.slice(before).filter(([pid, msg]) => pid === 'p_0' && ['m.field', 'b.snap'].includes(msg.t));
  assert.equal(frames[0][1].t, 'm.field');
  assert.deepEqual(frames[0][1].unitStats, cached, 'the very first rejoin metadata carries the original effective/base panel cache');
  const listed = new Set(frames[0][1].units.map(x => x.id));
  assert.ok(frames[0][1].unitStats.every(x => listed.has(x.id)), 'reconnect exposes cached details only for this view listed units');
  const resumed = frames.find(([, msg]) => msg.t === 'b.snap')[1];
  assert.equal(Object.hasOwn(resumed, 'unitStats'), false, 'the first rejoin snapshot is compact too');
  assert.deepEqual(resumed.units, periodic.units);
  for (const snap of h.allTo('p_0', 'b.snap')) {
    assert.equal(Object.hasOwn(snap, 'unitStats'), false);
    assert.ok(snap.units.every((x) => x.length === 9));
  }
  assert.deepEqual(h.logs.error, []);
});

test('g.unitStats: the board\'s start-of-battle stats (equipment in: ATK ×1.4, a slower attack), the same numbers the battle starts with; seq echoed', () => {
  const { h, m, ps, carrier } = setup();
  assert.deepEqual(m.handle('p_0', { t: 'g.unitStats', seq: 7 }), { ok: true });
  const msg = h.lastTo('p_0', 'm.unitStats');
  assert.ok(msg, 'answered with a push');
  assert.equal(msg.seq, 7);
  assert.equal(msg.round, 1);
  const boardUids = [...ps.board.values()].map((p) => p.uid).sort((a, b) => a - b);
  assert.deepEqual(msg.units.map((u) => u.uid).sort((a, b) => a - b), boardUids, 'every board unit, by uid');
  const u = msg.units.find((x) => x.uid === carrier.uid);
  assert.ok(u.atk > u.base.atk, `ATK up (${u.base.atk} → ${u.atk})`);
  assert.ok(Math.abs(u.atk - Math.round(u.base.atk * 1.4)) <= 1, `阿戈尔重刃 multiplies ATK by 1.4 (${u.atk})`);
  assert.ok(u.interval > u.base.interval, `attack speed −10: a longer interval (${u.base.interval} → ${u.interval})`);
  assert.equal(u.hp, u.maxHp, 'full HP at the start');
  assert.equal(u.alive, true);
  // exactly what the real battle of this board starts with (the same input, onBattleStart meta included)
  const b = m.newBattle(m._normalOpts(ps));
  b.start();
  const bu = b.allyUnits.find((x) => x.uid === carrier.uid);
  const { id: _a, ...want } = unitStatsEntry(bu, bu.s);
  const { id: _b, ...have } = u;
  assert.deepEqual(have, want);
  // no seq: null; a second request with the same state answers the cached numbers
  assert.deepEqual(m.handle('p_0', { t: 'g.unitStats' }), { ok: true });
  assert.equal(h.lastTo('p_0', 'm.unitStats').seq, null);
  assert.deepEqual(h.lastTo('p_0', 'm.unitStats').units, msg.units);
  m.dispose();
});

test('g.unitStats follows the prep state: another item changes the numbers; prep phases only', () => {
  const { h, m, ps, carrier } = setup(22);
  m.handle('p_0', { t: 'g.unitStats', seq: 1 });
  const before = h.lastTo('p_0', 'm.unitStats').units.find((x) => x.uid === carrier.uid);
  const item = giveItem(m, ps, ARM);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: item.uid, targetUid: carrier.uid }), { ok: true });
  assert.deepEqual(carrier.items.map((x) => x.id).sort(), [ARM, BLADE].sort());
  m.handle('p_0', { t: 'g.unitStats', seq: 2 });
  const after = h.lastTo('p_0', 'm.unitStats').units.find((x) => x.uid === carrier.uid);
  // equipment percentages are 直接乘算 — they add up (PRTS 盟约记录 / 游戏数据基础; DESIGN §20.10): +40 % and +30 % = +70 %
  assert.ok(Math.abs(after.atk - Math.round(after.base.atk * (1 + 0.4 + 0.3))) <= 1, `the items' percentages add up: ATK ${before.atk} → ${after.atk}`);
  // outside the prep phases: WRONG_PHASE, nothing pushed
  const n = h.allTo('p_0', 'm.unitStats').length;
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT));
  assert.equal(m.handle('p_0', { t: 'g.unitStats', seq: 3 }).error, ERR.WRONG_PHASE);
  assert.equal(h.allTo('p_0', 'm.unitStats').length, n);
  m.dispose();
});

test('prep stat previews do not spend a deployment skill duration in the next real battle', () => {
  const { h, m, ps } = setup(27);
  const id = 'chess_char_4_16_a'; // 缄默德克萨斯: a real timed deployment skill
  const piece = give(m, ps, id, 'board', legalTileFor(m, ps, id));
  const previews = [];
  const create = m.newBattle.bind(m);
  m.newBattle = (opts) => { const b = create(opts); previews.push(b); return b; };
  for (let i = 0; i < 3; i++) {
    m._unitStatsCache = null; // test fresh previews as well as the cached request
    assert.deepEqual(m.handle('p_0', { t: 'g.unitStats', seq: i }), { ok: true });
    const entry = h.lastTo('p_0', 'm.unitStats').units.find(u => u.uid === piece.uid);
    assert.ok(entry); assert.equal('sp' in entry, false); assert.equal('timeLeft' in entry, false);
  }
  assert.equal(m.phase, PHASE.PREP);
  for (const b of previews) {
    const u = b.allyUnits.find(u => u.uid === piece.uid);
    assert.equal(b.time, 0); assert.equal(b.tickCount, 0);
    assert.ok(u.skill.active); assert.equal(u.skill.timeLeft, u.skill.duration);
  }
  const b = create(m._normalOpts(ps)); const u = b.allyUnits.find(u => u.uid === piece.uid);
  assert.equal(b.started, false); assert.equal(u.deployed, false);
  b.start(); assert.equal(u.skill.timeLeft, u.skill.duration);
  b.step(); assert.ok(Math.abs(u.skill.timeLeft - (u.skill.duration - b.dt)) < 1e-8);
  assert.deepEqual(b.errors, []); m.dispose();
});

test('the preview changes nothing of the match: two identical matches, one asking for the stats all along, stay identical', () => {
  const run = (ask) => {
    const { h, m, ps } = setup(23);
    const snaps = [];
    for (let r = 1; r <= 3; r++) {
      if (ask) for (let k = 0; k < 3; k++) assert.deepEqual(m.handle('p_0', { t: 'g.unitStats', seq: k }), { ok: true });
      snaps.push(JSON.stringify(ps.privateView()));
      assert.ok(h.drive(() => m.phase === PHASE.PREP && m.round === r + 1), `PREP R${r + 1}`);
    }
    snaps.push(JSON.stringify(ps.privateView()), JSON.stringify({ ...m.publicView(), serverNow: 0, deadline: 0 }));
    m.dispose();
    return snaps;
  };
  assert.deepEqual(run(true), run(false));
});
