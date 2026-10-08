import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { RESULT_LIMITS, validateC2S } from '../../shared/protocol.js';
import { uniteRelayRound, uniteRelayKey, currentRelayField } from '../../public/js/battle/observe.js';
import { phaseBanner, uniteResultBox } from '../../public/js/ui/gameLogic/phases.js';
import { PhaseCapsule } from '../../public/js/ui/hud.js';
import { uniteDamageOwners, bossDamageOwners, damageGroups, acceptDamageSnapshot } from '../../public/js/ui/damageBoard.js';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';

const players = ['p1', 'p2', 'p3', 'p4', 'leaker'].map(playerId => ({ playerId, name: playerId }));
const first = { round: 1, fieldId: 'u', battleId: 'battle-1', helpers: ['p1', 'p2'], through: 7 };
const second = { round: 2, fieldId: 'u:2', battleId: 'battle-2', helpers: ['p3', 'p4'], through: 0 };
const relay = (round = 2) => ({ phase: PHASE.UNITE, round: 3, uniteRound: round, uniteRounds: 2, players,
  fields: [{ fieldId: round === 1 ? 'u' : 'u:2', kind: 'unite', players: round === 1 ? first.helpers : second.helpers }],
  unite: { battleId: round === 1 ? first.battleId : second.battleId, helpers: round === 1 ? first.helpers : second.helpers, rounds: round === 1 ? [] : [first] } });
const text = node => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

test('relay identity changes inside UNITE without changing the normal match round; legacy states stay single-round', () => {
  assert.equal(uniteRelayKey(relay(1)), '3:1');
  assert.equal(uniteRelayKey(relay(2)), '3:2');
  for (const pub of [{ phase: PHASE.UNITE, round: 3 }, { ...relay(), uniteRound: 3 }, { ...relay(), uniteRounds: 1 }, { ...relay(), phase: PHASE.COMBAT }]) {
    assert.equal(uniteRelayRound(pub), null); assert.equal(uniteRelayKey(pub), null);
  }
});

test('relay field admission waits for the new helper generation, including reconnect battleId', () => {
  assert.equal(currentRelayField(relay(), { fieldId: 'u', battleId: first.battleId }), false);
  assert.equal(currentRelayField(relay(), { fieldId: 'u:2', battleId: first.battleId }), false);
  assert.equal(currentRelayField(relay(), { fieldId: 'u:2', battleId: second.battleId }), true);
  assert.equal(currentRelayField({ ...relay(), fields: [] }, { fieldId: 'u:2' }), false);
  assert.equal(currentRelayField({ phase: PHASE.COMBAT }, { fieldId: 'n:p1' }), true);
});

test('banner and persistent capsule identify each relay; ordinary unite labels remain unchanged', () => {
  for (const round of [1, 2]) {
    const pub = relay(round), banner = phaseBanner(PHASE.UNITE, pub);
    assert.match(banner.title, new RegExp(`第 ${round} 轮`));
    assert.equal(banner.micro, `JOINT DEFENSE ${round}/2`);
    assert.ok(text(PhaseCapsule({ pub, hud: { killed: 0, total: 7 } })).includes(`联防 ${round}/2`));
  }
  const pub = { ...relay(1), uniteRounds: undefined, uniteRound: undefined };
  assert.equal(phaseBanner(PHASE.UNITE, pub).title, '联防阶段');
  assert.ok(text(PhaseCapsule({ pub, hud: null })).includes('联防'));
});

test('damage scope unions actual relay helpers, never leak sources, and reads the absolute ledger once', () => {
  const pub = relay(), before = structuredClone(pub);
  const owners = uniteDamageOwners({ pub, fieldId: 'u:2' });
  assert.deepEqual(owners.map(p => p.playerId), ['p1', 'p2', 'p3', 'p4']);
  const snapshot = { matchId: 'm1', round: 3, status: 'live', owners: players.map((p, i) => ({ ...p, total: (i + 1) * 100, operators: [], otherDamage: (i + 1) * 100 })) };
  assert.equal(damageGroups(snapshot, [...owners, ...owners]).total, 1000);
  assert.equal(acceptDamageSnapshot(snapshot, { ...snapshot, owners: snapshot.owners.slice() }, 'm1').owners.length, 5);
  assert.deepEqual(pub, before);
  assert.deepEqual(uniteDamageOwners({ pub: relay(1), fieldId: 'u' }).map(p => p.playerId), ['p1', 'p2']);
});

test('settle/reconnect retains both helper groups without a local history and uses only final LP charges', () => {
  const pub = { ...relay(), phase: PHASE.SETTLE, fields: [], uniteResult: { helpers: [...first.helpers, ...second.helpers], rounds: [first, second], through: 0, losses: { p1: 0, leaker: 0 } } };
  const field = { fieldId: 'u:2', round: 3, players: second.helpers };
  assert.equal(uniteDamageOwners({ pub, fieldId: 'u:2', field }).length, 4);
  assert.equal(uniteDamageOwners({ pub, fieldId: 'u:2', field: { ...field, round: 2 } }), null);
  assert.equal(uniteResultBox(pub.uniteResult, 'leaker').sub, '全员无伤！');
  assert.equal(uniteResultBox({ ...pub.uniteResult, through: 2, losses: { leaker: 2 } }, 'leaker').sub, '生命值减少 −2');
  assert.equal(uniteResultBox(pub.uniteResult, 'observer'), null);
});

test('relay never widens an individual unite field or another Boss pair', () => {
  assert.equal(uniteDamageOwners({ pub: { ...relay(), fields: [{ fieldId: 'u:2', kind: 'unite', players: ['p1', 'p2', 'p3'] }] }, fieldId: 'u:2' }), null);
  assert.equal(uniteDamageOwners({ pub: { ...relay(), phase: PHASE.PREP }, fieldId: 'u:2' }), null);
  const pub = { ...relay(), phase: PHASE.FINAL_ASSAULT, fields: [{ fieldId: 'b1', kind: 'boss', players: ['p1', 'p2'] }] };
  assert.deepEqual(bossDamageOwners({ pub, fieldId: 'b1' }).map(p => p.playerId), ['p1', 'p2']);
  assert.equal(RESULT_LIMITS.players, 4);
});

test('portrait expanded games separate the connection, clock and relay capsule without changing ordinary layout', () => {
  const css = readFileSync(new URL('../../public/css/screens/game.css', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 600px\) and \(orientation: portrait\)/);
  assert.match(css, /\.gm--expanded \.gtop \{[^}]*grid-template-areas: "connection clock" "phase phase"/);
  assert.match(screen, /pub\?\.playerCapacity > 4 && 'gm--expanded'/);
});

// Transport/session fixtures only: physics and settlement are covered by real Battle/Worker backend tests.
function runnerRig() {
  const handlers = new Map(), sent = [];
  let offline = true;
  const net = { on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); },
    emit(type, msg) { return handlers.get(type)?.(msg); },
    send(type, fields) { assert.equal(validateC2S({ t: type, ...fields }), null); sent.push({ t: type, ...fields }); },
    request(type, fields) { sent.push({ t: type, ...fields }); return offline ? Promise.reject({ code: 'OFFLINE' }) : Promise.resolve({ t: 'ok' }); } };
  const result = { reason: 'forced', time: 0, killed: 0, total: 0, perPlayer: { p1: { killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, unitsEnd: [] } } };
  const left = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`leaker${i}`, 1]));
  const sim = { ds: {}, spec: { createBattleFromSpec(spec) { return { flags: { layerGainsEnabled: false }, finished: false, tickCount: 0, time: 0, killed: 0, total: 20,
    fieldMeta: () => ({ units: [], rect: spec.rect }), drainEvents: () => [], snapshot: () => ({ t: 0, units: [] }), result: () => result,
    forceEnd() { this.finished = true; } }; }, attachLpMeter: () => ({ lp: 0 }), uniteLeft: () => left,
    battleProgress: b => ({ gt: 0, killed: 0, total: 20, done: b.finished, leaks: 0, left }), compactResult: x => x } };
  const store = createStore(initialState);
  const runner = createBattleRunner({ net, store, loadSim: async () => sim, now: () => 0, raf: () => 1, caf() {}, setInterval: () => 1, clearInterval() {}, doc: null });
  const start = (id, fieldId) => net.emit('b.start', { battleId: id, fieldId, kind: 'unite', authoritative: true, elapsed: 0, spec: { fieldId, kind: 'unite', players: [{ playerId: 'p1' }], rect: {} } });
  return { runner, net, store, sent, start, online() { offline = false; net.emit('status', { status: 'online' }); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('second relay detaches the old view but preserves an undelivered authoritative result for reconnect', async () => {
  const r = runnerRig();
  try {
    r.store.patch('match', { public: relay(1) }); await r.start('battle-1', 'u'); await flush();
    assert.equal(r.runner.state().battleId, 'battle-1');
    r.net.emit('b.end', { battleId: 'battle-1', reason: 'forced' }); await flush();
    assert.equal(r.runner._entries.get('battle-1').delivery, 'undelivered');
    r.store.patch('match', { public: relay(2) });
    assert.equal(r.runner.state(), null);
    assert.ok(r.runner._entries.has('battle-1'), 'result must not be cleared with the old view');
    await r.start('battle-2', 'u:2'); await flush();
    assert.equal(r.runner.state().battleId, 'battle-2');
    r.online(); await flush();
    assert.equal(r.runner._entries.get('battle-1').delivery, 'delivered');
    assert.equal(r.sent.filter(m => m.t === 'b.result' && m.battleId === 'battle-1').length, 2);
  } finally { r.runner.dispose(); }
});

test('client progress keeps all twenty leak sources without expanding per-field result participants', async () => {
  const r = runnerRig();
  try {
    r.store.patch('match', { public: relay(1) }); await r.start('battle-1', 'u'); await flush();
    r.net.emit('b.end', { battleId: 'battle-1', reason: 'forced' }); await flush();
    const progress = r.sent.find(m => m.t === 'b.progress');
    assert.equal(Object.keys(progress.left).length, 20);
    assert.equal(RESULT_LIMITS.players, 4);
  } finally { r.runner.dispose(); }
});
