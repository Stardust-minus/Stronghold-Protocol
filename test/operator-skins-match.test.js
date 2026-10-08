import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_SKINS } from '../shared/skins.js';
import { PHASE, ERR, GEO } from '../shared/constants.js';
import { DATA, makeMatch, legalTileFor } from './match/harness.js';
import { makeBattle } from './helpers/battleHarness.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { unitInfo } from '../server/sim/snapshot.js';
import { buildResult } from '../server/match/results.js';

const CHAR = 'char_103_angel', ID = 'chess_char_3_01_a', ELITE = 'chess_char_3_01_b';
const A = OPERATOR_SKINS[0].id, B = OPERATOR_SKINS[1].id;
const choices = (id = A) => ({ [CHAR]: id });
const wire = value => JSON.parse(JSON.stringify(value));
const withoutSkin = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'skinId' ? undefined : v));
const seat = (i, extra = {}) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true, ...extra });
function place(ps, id, r = 9, c = 3) {
  const piece = ps.newPiece('chess', id);
  ps.board.set(`${r},${c}`, piece); return piece;
}
function clear(ps) { ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); }

test('Match/PlayerState skin contract is copied, frozen, independent of loadout, bots, phase and other seats', t => {
  const input = choices();
  const h = makeMatch({ seats: [seat(0, { skins: input }), seat(1), { ...seat(2, { skins: input }), playerId: 'ai_0', isBot: true }] }).start();
  t.after(() => h.m.dispose());
  const ps = h.ps('p_0'), lo = ps.loadout;
  input[CHAR] = B;
  assert.deepEqual(ps.skins, choices()); assert.ok(Object.isFrozen(ps.skins));
  assert.deepEqual(h.ps('p_1').skins, {}); assert.deepEqual(h.ps('ai_0').skins, {});
  assert.equal(h.m.setSkins('ai_0', choices()).error, ERR.NOT_IN_ROOM);
  assert.equal(h.m.setSkins('stranger', choices()).error, ERR.NOT_IN_ROOM);
  assert.equal(h.m.setSkins('p_0', { [CHAR]: 'invalid' }).error, ERR.BAD_MSG);
  assert.deepEqual(ps.skins, choices());
  assert.deepEqual(h.m.setSkins('p_0', choices(B)), { ok: true });
  assert.deepEqual(h.lastTo('p_0', 'm.private').skins, choices(B));
  assert.equal(ps.loadout, lo);
  assert.equal(h.m.phase, PHASE.INFO_CHECK);
  for (const phase of Object.values(PHASE).filter(p => p !== PHASE.INFO_CHECK)) {
    h.m.phase = phase;
    assert.equal(h.m.setSkins('p_0', {}).error, ERR.WRONG_PHASE, phase);
    assert.deepEqual(ps.skins, choices(B));
  }
  h.m.phase = PHASE.INFO_CHECK; h.m.ended = true;
  assert.equal(h.m.setSkins('p_0', {}).error, ERR.WRONG_PHASE);
});

test('own pieces, scout board/hand/temp, BossMate, observer and prep reconnect use the owner\'s resolved skinId', t => {
  const h = makeMatch({ seats: [seat(0, { skins: choices() }), seat(1, { skins: choices(B) })], spectators: ['watcher'] }).start();
  t.after(() => h.m.dispose()); h.toPrep(1);
  const p0 = h.ps('p_0'), p1 = h.ps('p_1'); clear(p0); clear(p1);
  const board = place(p0, ID), elite = place(p0, ELITE, 10, 3), other = place(p1, ID);
  p0.hand[0] = p0.newPiece('chess', ID); p0.temp[0] = p0.newPiece('chess', ELITE);
  assert.equal(p0.pieceView(board).skinId, A); assert.equal(p1.pieceView(other).skinId, B);
  const meta = wire(h.m.prepFieldMeta(p0));
  assert.equal(meta.units.length, 4); assert.ok(meta.units.every(u => u.skinId === A));
  assert.ok(meta.units.some(u => u.y === GEO.HAND_ROW)); assert.ok(meta.units.some(u => u.y === GEO.TEMP_ROW));
  assert.ok(meta.units.every(u => !Object.hasOwn(u, 'skins')));
  assert.equal(meta.units.find(u => u.uid === elite.uid).spine, DATA.chess[ELITE].assets.spine, 'original spine/identity unchanged');
  h.m.handle('watcher', { t: 'g.watch', fieldId: 'n:p_0' });
  assert.ok(h.lastTo('watcher', 'm.field').units.every(u => u.skinId === A));
  assert.equal(h.sent.some(([pid, frame]) => pid === 'watcher' && frame.t === 'm.private'), false);
  h.m._resync(h.m.spectators.get('watcher'));
  assert.ok(h.lastTo('watcher', 'm.field').units.every(u => u.skinId === A));
  h.m.onReconnect('p_0');
  assert.deepEqual(h.lastTo('p_0', 'm.private').skins, choices());
  h.m.bossWaves = [{ players: ['p_0', 'p_1'], wave: { spawns: [] } }];
  const mate = h.m.bossMateView(p0);
  assert.equal(mate.playerId, 'p_1'); assert.equal(mate.units.find(u => u.uid === other.uid).skinId, B);
  const bossScout = h.m.prepFieldMeta(p0);
  assert.equal(bossScout.kind, 'boss');
  assert.equal(bossScout.units.find(u => u.ownerId === 'p_1').skinId, B);
  assert.ok(bossScout.units.filter(u => u.ownerId === 'p_0').every(u => u.skinId === A));
  assert.equal(JSON.stringify(h.m.publicView()).includes('skins'), false);
  const result = buildResult(h.m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'test' });
  assert.ok(result.players.find(p => p.playerId === 'p_0').lineup.every(u => u.skinId === A));
  assert.ok(result.players.find(p => p.playerId === 'p_1').lineup.every(u => u.skinId === B));
});

test('stand-ins never inherit the replaced operator\'s skin (normal/elite, own/scout/spec/result)', t => {
  const h = makeMatch({ seats: [seat(0, { skins: choices(), notOwned: [ID] }), seat(1, { skins: choices(B) })] }).start();
  t.after(() => h.m.dispose()); h.toPrep(1);
  const ps = h.ps('p_0'); clear(ps);
  for (const [index, id] of [ID, ELITE].entries()) {
    const tile = legalTileFor(h.m, ps, id); assert.ok(tile);
    place(ps, id, tile[0], tile[1] + index);
    assert.equal(ps.skinIdFor(ps.gd.chess(id)), null);
  }
  // Input recompute may evict an illegal adjacent fixture tile, but every actual piece must still be a stand-in.
  const input = ps.battleInput(); assert.ok(input.units.length);
  assert.ok(input.units.every(u => u.standIn && !Object.hasOwn(u, 'skinId')));
  assert.ok([...ps.board.values()].every(p => !Object.hasOwn(ps.pieceView(p), 'skinId')));
  assert.ok(h.m.prepFieldMeta(ps).units.every(u => !Object.hasOwn(u, 'skinId')));
  const result = buildResult(h.m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'test' });
  assert.ok(result.players[0].lineup.every(u => u.standInFor === CHAR && !Object.hasOwn(u, 'skinId')));
});

test('DIY display resolves the real charId, never its slot; synthetic future skin-capable DIY fixture', t => {
  const h = makeMatch({ humans: 1 }).start(); t.after(() => h.m.dispose()); h.toPrep(1);
  const ps = h.ps('p_0'); clear(ps); ps.setSkins(choices());
  // Current manifest contains only Exusiai, who is not currently a legal DIY pick. Do not widen production pools.
  // Model the already-composed player data view to exercise the display plumbing for future skin-capable DIY picks.
  const slot = 'chess_char_5_diy1_a', body = { ...DATA.chess[ID], chessId: slot, baseId: slot, isDiy: true, diyFor: slot };
  const gd = ps.gd;
  ps.gd = Object.create(gd); ps.gd.chess = id => id === slot ? body : gd.chess(id);
  ps.diy = Object.freeze({ [slot]: Object.freeze({ charId: CHAR, skillIndex: body.skill.index, uniEquipId: null }) });
  ps._diyRecords.set(slot, body);
  const piece = place(ps, slot);
  assert.equal(ps.pieceView(piece).skinId, A);
  assert.equal(h.m._prepBoardUnits(ps)[0].skinId, A);
  assert.equal(ps.battleInput().units[0].skinId, A);
  assert.equal(ps.battleInput().units[0].diy.charId, CHAR);
  const result = buildResult(h.m, { victory: false, hiddenReached: false, hiddenCleared: false, reason: 'test' });
  assert.equal(result.players[0].lineup[0].skinId, A); assert.equal(result.players[0].lineup[0].diy.charId, CHAR);
});

test('BattleSpec admits/clones optional manifest keys, drops unsafe/token choices; actual resolved def rejects wrong operator', () => {
  const original = { players: [{ playerId: 'p', units: [
    { uid: 1, chessId: ID, row: 10, col: 3, skinId: A },
    { uid: 2, chessId: ID, row: 10, col: 4, skinId: '../evil' },
    { uid: 3, kind: 'token', tokenId: 'token_x', row: 10, col: 5, skinId: A },
  ] }] };
  const built = buildBattleSpec(original);
  assert.equal(built.players[0].units[0].skinId, A);
  assert.equal(Object.hasOwn(built.players[0].units[1], 'skinId'), false);
  assert.equal(Object.hasOwn(built.players[0].units[2], 'skinId'), false);
  assert.equal(original.players[0].units[1].skinId, '../evil', 'input is not mutated');
  let received;
  class Capture { constructor(opts) { received = opts; } }
  createBattleFromSpec({ ...built, players: original.players }, null, { BattleClass: Capture });
  assert.equal(received.players[0].units[0].skinId, A);
  assert.equal(Object.hasOwn(received.players[0].units[1], 'skinId'), false);
  received.players[0].units[0].skinId = B;
  assert.equal(original.players[0].units[0].skinId, A);
  const h = makeBattle({ units: [{ chessId: ID, row: 10, col: 3, standIn: true, skinId: A },
    { chessId: 'chess_char_4_22_a', row: 10, col: 4, skinId: A }] });
  assert.ok(h.allies().every(u => !Object.hasOwn(u, 'skinId')));
  assert.ok(h.allies().every(u => !Object.hasOwn(unitInfo(u), 'skinId')));
});

test('shared unite/boss/hidden fields carry per-instance choices without cross-owner/default contamination', () => {
  for (const kind of ['unite', 'boss', 'hidden']) {
    const h = makeBattle({ kind, players: [
      { playerId: 'A', side: 'L', units: [{ uid: 11, chessId: ID, row: 10, col: 3, skinId: A }] },
      { playerId: 'B', side: 'R', colOffset: 8, units: [{ uid: 21, chessId: ID, row: 10, col: 3, skinId: B }, { uid: 22, chessId: ID, row: 11, col: 3 }] },
    ] });
    h.step();
    const by = new Map(h.b.fieldMeta().units.map(u => [u.uid, u]));
    assert.equal(by.get(11).skinId, A); assert.equal(by.get(21).skinId, B); assert.equal(Object.hasOwn(by.get(22), 'skinId'), false);
    assert.ok(h.b.allyUnits.every(u => !Object.hasOwn(u.def, 'skinId')), 'no skin metadata in shared battle defs');
    const events = new Map(h.eventsOf('spawn').map(e => [e[1].uid, e[1]]));
    assert.equal(events.get(11).skinId, A); assert.equal(events.get(21).skinId, B);
    assert.deepEqual(withoutSkin(by.get(21)), withoutSkin(unitInfo(h.b.allyUnits.find(u => u.uid === 21))));
  }
});

test('all three skins leave numerical tuples, combat/RNG/results, skills and attack timings byte-identical', () => {
  const run = skinId => {
    const h = makeBattle({ seed: 771, units: [{ uid: 1, chessId: ELITE, row: 10, col: 4, ...(skinId ? { skinId } : {}) }],
      enemies: [{ key: 'enemy_1007_slime', time: 0, route: 0 }], timeLimit: 15 });
    const snapshots = [];
    while (!h.b.finished) { h.step(); snapshots.push(JSON.stringify(h.b.snapshot())); }
    return { h, snapshots, result: JSON.stringify(h.result()), rng: h.b.rng.state(), events: JSON.stringify(withoutSkin(h.events)), def: h.allies()[0].def };
  };
  const base = run(); assert.equal(Object.hasOwn(base.h.allies()[0], 'skinId'), false);
  assert.equal(Object.hasOwn(base.h.b.fieldMeta().units.find(u => u.side === 'ally'), 'skinId'), false);
  assert.ok(base.h.result().perPlayer.p1.damageDealt > 0, 'comparison actually exercises attacks');
  for (const skin of OPERATOR_SKINS.filter(s => s.charId === CHAR)) {
    const shown = run(skin.id);
    assert.equal(shown.h.allies()[0].skinId, skin.id);
    assert.deepEqual(shown.snapshots, base.snapshots); assert.equal(shown.result, base.result);
    assert.deepEqual(shown.rng, base.rng); assert.equal(shown.events, base.events); assert.deepEqual(shown.def, base.def);
  }
});
