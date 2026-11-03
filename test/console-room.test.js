// 调控台 (feedback #125, the owner's decisions of 2026-11-03): a private room's `experimental.console` switch makes its
// matches test matches (DESIGN §34.8 phase 2) without the input journal — every seated player commands their own seat, a
// match-wide command only as the match's only human, a per-player rate bucket, bounty counts with a per-battle cap and no
// leaders, co-op grants outside the shared pool — while the lobby keeps it out of room.create, matchmaking and the room
// list, and a game node sees it through the options it already copies. No listeners.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPERIMENTAL_DEFAULTS, experimentalKey, experimentalOptions, isConsoleRoom, isExperimental, sameExperimental } from '../shared/experimental.js';
import { autoPoolPlan } from '../shared/poolPlan.js';
import { parseTestArgs, TEST_RATE_COUNT, TEST_BOUNTY_BATTLE_MAX } from '../shared/testMode.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { copyAssignmentSpec } from '../server/cluster/game-host.js';
import { makeMatch, DATA } from './match/harness.js';
import { buildResult } from '../server/match/results.js';
import { canSnapshot } from '../server/match/snapshot.js';
import { explainTestDetail } from '../public/js/ui/testAudit.js';
import { testConsoleAccess } from '../public/js/ui/testConsole.js';

const CONSOLE = Object.freeze({ ...EXPERIMENTAL_DEFAULTS, console: true });
const ok = (r) => assert.deepEqual(r, { ok: true });

test('experimental.console is an optional stored flag with its own key and comparison', () => {
  const on = experimentalOptions(CONSOLE);
  assert.equal(on.console, true);
  assert.equal(isConsoleRoom(on), true);
  assert.equal(isConsoleRoom(experimentalOptions(EXPERIMENTAL_DEFAULTS)), false);
  assert.equal(Object.hasOwn(experimentalOptions({ ...EXPERIMENTAL_DEFAULTS, console: false }), 'console'), false, 'off is absent');
  assert.equal(isExperimental({ ...EXPERIMENTAL_DEFAULTS, console: 'yes' }), false);
  assert.equal(sameExperimental(on, experimentalOptions(EXPERIMENTAL_DEFAULTS)), false);
  assert.equal(sameExperimental(on, experimentalOptions(CONSOLE)), true);
  assert.notEqual(experimentalKey(on), experimentalKey(experimentalOptions(EXPERIMENTAL_DEFAULTS)));
  // every option at once (both HP forms as the raw input may carry them) still passes the shape check
  const all = { revivalEnabled: true, disableSharedPool: false, playerCapacity: 8, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true,
    enemyHpMul: 2, enemyHpPlan: [[1, 1], [6, 2]], enemyAtkMul: 2, poolPlan: autoPoolPlan(8), collabOps: true, console: true };
  assert.equal(Object.keys(all).length, 12);
  assert.equal(isExperimental(all), true);
  assert.equal(experimentalOptions(all).console, true);
});

test('bounty takes an optional count of 1..20', () => {
  assert.deepEqual(parseTestArgs('bounty', { enemyKey: 'e' }), { args: { enemyKey: 'e' } });
  assert.deepEqual(parseTestArgs('bounty', { enemyKey: 'e', count: 20 }), { args: { enemyKey: 'e', count: 20 } });
  for (const count of [0, 21, 1.5, '3']) assert.equal(parseTestArgs('bounty', { enemyKey: 'e', count }).error, 'BAD_TARGET');
  assert.equal(parseTestArgs('bounty', { enemyKey: 'e', extra: 1 }).error, 'BAD_MSG');
  assert.deepEqual(parseTestArgs('chess', { id: 'x' }), { args: { id: 'x' } });
  assert.equal(parseTestArgs('chess', { id: 'x', count: 2 }).error, 'BAD_MSG');
});

function openLobby(t, extra = {}) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({
    registry,
    content: { cs: 'ab'.repeat(32) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ...extra,
    options: { testMode: extra.testMode ?? 'off', testHost: extra.testHost },
  });
  t.after(() => lobby.shutdown());
  const player = (name) => {
    const s = registry.create(name);
    s.connected = true;
    s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send: (txt) => s.messages.push(JSON.parse(txt)) };
    return s;
  };
  return { lobby, player };
}

test('the console is a private room setting: never at create, never queued, listed or matchmade', (t) => {
  const { lobby, player } = openLobby(t);
  const host = player('host');
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', experimental: CONSOLE }).error, 'BAD_MSG');
  ok(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }));
  const room = lobby.roomOf(host);
  ok(lobby.setExperimental(host, { experimental: CONSOLE }));
  assert.equal(isConsoleRoom(room.experimental), true);
  assert.equal(lobby.listable(room), false);
  assert.equal(lobby.matchmakingMembers(host, 'NORMAL', true).error, 'BAD_MSG');
  ok(lobby.setExperimental(host, { experimental: EXPERIMENTAL_DEFAULTS }));
  assert.equal(isConsoleRoom(room.experimental), false);
  // a matchmade room never takes it
  room.source = 'matchmaking';
  assert.equal(lobby.setExperimental(host, { experimental: CONSOLE }).error, 'BAD_MSG');
  // a solo room may
  const solo = player('solo');
  ok(lobby.create(solo, { mode: 'solo', difficulty: 'NORMAL' }));
  ok(lobby.setExperimental(solo, { experimental: CONSOLE }));
});

test('a test room cannot queue as a party either (the upstream gap)', (t) => {
  const { lobby, player } = openLobby(t, { testMode: '1', testHost: '127.0.0.1' });
  const host = player('host');
  ok(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', test: true }));
  assert.equal(lobby.matchmakingMembers(host, 'NORMAL', true).error, 'BAD_MSG');
});

test('a console room starts a match with the switch in its options and routes g.test with the test gate off', (t) => {
  const seen = [], calls = [];
  class Rec {
    constructor(opts) { seen.push(opts); }
    start() {}
    dispose() {}
    handle(id, msg) { calls.push([id, msg.t]); return { ok: true }; }
  }
  const { lobby, player } = openLobby(t, { MatchClass: Rec });
  const host = player('host');
  ok(lobby.create(host, { mode: 'solo', difficulty: 'NORMAL' }));
  const room = lobby.roomOf(host);
  ok(lobby.startMatch(room));
  assert.equal(lobby.routeGameNow(host, { t: 'g.test', cmd: 'funds', args: { amount: 1 } }).error, 'TEST_DISABLED');
  room.match = null;
  ok(lobby.setExperimental(host, { experimental: CONSOLE }));
  ok(lobby.startMatch(room));
  const opts = seen.at(-1);
  assert.equal(opts.test, undefined, 'no test key: the options carry the switch');
  assert.equal(opts.experimental.console, true);
  ok(lobby.routeGameNow(host, { t: 'g.test', cmd: 'funds', args: { amount: 1 } }));
  assert.deepEqual(calls.at(-1), [host.playerId, 'g.test']);
});

test('a game node copies the switch with the assignment options', () => {
  const seat = (n, id) => ({ seat: n, playerId: id, name: id, isBot: false, connected: true });
  const spec = copyAssignmentSpec({ assignmentId: 'console-a', roomCode: 'ABCD', build: 'b', protocol: 1, seed: 7, matchNo: 1,
    mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seats: [seat(0, 'p1'), seat(1, 'p2')], spectators: [],
    experimental: CONSOLE });
  assert.equal(spec.experimental.console, true);
});

function consoleMatch(t, opts = {}) {
  const lines = [];
  const h = makeMatch({ experimental: CONSOLE, log: { info: (...a) => lines.push(a.map(String).join(' ')) }, ...opts });
  t.after(() => h.m.dispose());
  h.start(); h.toPrep();
  h.cmd = (cmd, args = {}, who = 'p_0') => h.m.handle(who, { t: 'g.test', cmd, args });
  h.lines = lines;
  return h;
}

test('a console match is a test match without the input journal, never checkpointed, and counts for nothing', (t) => {
  const h = consoleMatch(t, { mode: 'solo' });
  assert.equal(h.m.test, true);
  assert.equal(h.m.consoleRoom, true);
  ok(h.cmd('funds', { amount: 500 }));
  assert.equal(h.ps('p_0').funds, 500);
  assert.equal(h.lines.some((l) => l.includes('[test-input')), false, 'no journal');
  assert.equal(h.lines.some((l) => l.includes('[test-audit')), true, 'the audit stays');
  assert.equal(canSnapshot(h.m), false);
  assert.equal(h.m.publicView().test, true);
  const result = buildResult(h.m, { victory: true, hiddenCleared: true });
  assert.equal(result.test, true);
  for (const row of result.players) { assert.equal(row.title, null); assert.equal(row.trophies, 0); assert.equal(row.reward, 0); }
});

test('co-op: every seated player commands their own seat; match-wide commands need the only human', (t) => {
  const h = consoleMatch(t, { mode: 'coop', humans: 2, spectators: ['watch'] });
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  ok(h.cmd('funds', { amount: 90 }, 'p_1'));
  assert.equal(b.funds, 90);
  ok(h.cmd('funds', { amount: 40 }, 'p_0'));
  assert.equal(a.funds, 40); assert.equal(b.funds, 90);
  assert.equal(h.cmd('funds', { amount: 9 }, 'watch').error, 'SPECTATOR');
  for (const [cmd, args] of [['round', { round: 3 }], ['phase', { name: 'combat' }], ['timers', { on: false }], ['teamLp', { value: 1 }], ['hp', { value: 1 }]]) {
    const r = h.cmd(cmd, args, 'p_1');
    assert.equal(r.error, 'TEST_FORBIDDEN', cmd);
    assert.equal(r.detail, 'shared', cmd);
  }
  assert.equal(h.m.testLog.at(-1).detail, 'shared');
  assert.equal(h.m.phase, 'PREP');
  // the rate bucket is per player
  for (let i = 0; i < TEST_RATE_COUNT - 1; i++) h.cmd('funds', { amount: -1 }, 'p_0');
  assert.equal(h.cmd('funds', { amount: 1 }, 'p_0').error, 'RATE');
  ok(h.cmd('funds', { amount: 1 }, 'p_1'));
});

test('match-wide commands work for the only human: solo, or co-op with AI teammates', (t) => {
  const solo = consoleMatch(t, { mode: 'solo' });
  ok(solo.cmd('timers', { on: false }));
  ok(solo.cmd('timers', { on: true }));
  const bots = consoleMatch(t, { mode: 'coop', humans: 1, bots: 3 });
  ok(bots.cmd('timers', { on: false }));
  ok(bots.cmd('timers', { on: true }));
  ok(bots.cmd('round', { round: 2 }));
});

test('bounty: counts, at most 20 waiting per player, no leader', (t) => {
  const h = consoleMatch(t, { mode: 'coop', humans: 2 });
  const leaders = new Set(Object.values(DATA.bosses).map((b) => b.enemyKey));
  const enemyKey = Object.keys(DATA.enemies).find((id) => !h.m.gd.inactiveEnemies.has(id) && !leaders.has(id));
  const waiting = (ps) => ps.bounties.reduce((n, b) => n + b.card.count, 0);
  ok(h.cmd('bounty', { enemyKey, count: 5 }));
  assert.equal(waiting(h.ps('p_0')), 5);
  const over = h.cmd('bounty', { enemyKey, count: 16 });
  assert.equal(over.error, 'BAD_TARGET');
  assert.match(over.detail, /^bounty\|/);
  assert.match(explainTestDetail(over.detail), /20/);
  ok(h.cmd('bounty', { enemyKey, count: 15 }));
  assert.equal(waiting(h.ps('p_0')), TEST_BOUNTY_BATTLE_MAX);
  assert.equal(h.cmd('bounty', { enemyKey }).error, 'BAD_TARGET');
  ok(h.cmd('bounty', { enemyKey, count: 20 }, 'p_1'), 'the cap is per player');
  const leader = [...leaders].find((id) => DATA.enemies[id] && !h.m.gd.inactiveEnemies.has(id));
  const r = h.cmd('bounty', { enemyKey: leader }, 'p_1');
  assert.equal(r.error, 'BAD_TARGET'); assert.equal(r.detail, 'leader');
});

test('a co-op chess grant leaves the shared pool alone; solo keeps the upstream accounting', (t) => {
  const id = 'chess_char_3_19_a';
  const h = consoleMatch(t, { mode: 'coop', humans: 2 });
  const p = h.ps('p_0'), pool = p.poolOf(id);
  const before = pool.left(id);
  ok(h.cmd('chess', { id }));
  assert.ok([...p.hand, ...p.temp].some((x) => x?.id === id));
  assert.equal(pool.left(id), before);
  const solo = consoleMatch(t, { mode: 'solo' });
  const sp = solo.ps('p_0'), spool = sp.poolOf(id), sb = spool.left(id);
  ok(solo.cmd('chess', { id }));
  assert.equal(spool.left(id), sb - 1);
});

test('the client panel: every seated player of a console match, match-wide controls for the only human', () => {
  const pub = (players, extra = {}) => ({ test: true, experimental: CONSOLE, players, ...extra });
  const two = [{ playerId: 'a', isBot: false }, { playerId: 'b', isBot: false }];
  assert.deepEqual(testConsoleAccess(pub(two), 'b', 'a'), { show: true, console: true, shared: false });
  assert.deepEqual(testConsoleAccess(pub(two), 'watcher', 'a'), { show: false, console: true, shared: false });
  assert.deepEqual(testConsoleAccess(pub([{ playerId: 'a', isBot: false }, { playerId: 'ai_1', isBot: true }]), 'a', 'a'), { show: true, console: true, shared: true });
  // an upstream test match: the host only, every control
  const test = { test: true, players: two };
  assert.deepEqual(testConsoleAccess(test, 'a', 'a'), { show: true, console: false, shared: true });
  assert.equal(testConsoleAccess(test, 'b', 'a').show, false);
  assert.equal(testConsoleAccess({ players: two, experimental: CONSOLE }, 'a', 'a').show, false, 'not a test match');
});

import { chessOptions, itemOptions, bondOptions, bandOptions, enemyOptions, ownedPieces, tokenOptions, pickModel, currentLayers,
  consoleCommandText, consoleLogText, consoleCommands, SEARCH_MIN } from '../public/js/ui/consolePanel.js';

test('console pickers list names, never ids: 干员 by tier (normal in-pool forms + the own slotted 自选), 装备, 盟约, 敌人', () => {
  const chess = DATA.chess;
  const list = chessOptions(chess, { diy: { chess_char_6_diy1_a: { charId: 'char_4247_oxi', skillIndex: 2, uniEquipId: null } }, backups: DATA.backups });
  assert.ok(list.length > 100);
  assert.ok(list.every((o) => !chess[o.value].isGolden && (!chess[o.value].isDiy || o.value === 'chess_char_6_diy1_a') && chess[o.value].isHidden !== true));
  assert.deepEqual([...new Set(list.map((o) => o.group))], [1, 2, 3, 4, 5, 6]);
  const oxi = list.find((o) => o.value === 'chess_char_6_diy1_a');
  assert.equal(oxi.group, 6); assert.match(oxi.name, /^塔露拉/);
  assert.ok(list.every((o) => o.name && !o.name.startsWith('chess_')), 'names, not ids');
  const items = itemOptions(DATA.items);
  assert.ok(items.length > 40 && items.every((o) => !DATA.items[o.value].isGolden));
  const mode = DATA.config.modes.mode_single_funny;
  const bonds = bondOptions(DATA.bonds, mode.inactiveBondIds);
  assert.ok(bonds.length > 0 && bonds.every((o) => !mode.inactiveBondIds.includes(o.value)));
  assert.ok(bandOptions(DATA.bands, 'SINGLE').length > 0);
  const leaders = new Set(Object.values(DATA.bosses).map((b) => b.enemyKey));
  const foes = enemyOptions(DATA.enemies, DATA.bosses, mode.inactiveEnemyKeys);
  assert.ok(foes.length > 50);
  assert.ok(foes.every((o) => !leaders.has(o.value) && DATA.enemies[o.value].tokenOnly !== true && !mode.inactiveEnemyKeys.includes(o.value)));
  assert.ok(list.length > SEARCH_MIN && foes.length > SEARCH_MIN, 'both get a 搜索 field');
});

test('search keeps the select on a shown option; owned pieces and their summons by name; current layers', () => {
  const opts = [{ value: 'a', name: '能天使' }, { value: 'b', name: '安洁莉娜' }, { value: 'c', name: '天火' }];
  assert.deepEqual(pickModel(opts, '天', 'b'), { shown: [opts[0], opts[2]], value: 'a' });
  assert.deepEqual(pickModel(opts, '', 'b').value, 'b');
  assert.deepEqual(pickModel(opts, '无', 'b'), { shown: [], value: '' });
  const id = 'chess_char_3_19_a';
  const priv = { hand: [{ kind: 'chess', uid: 4, id }, { kind: 'item', uid: 5, id: 'x' }], temp: [], board: [{ piece: { kind: 'chess', uid: 9, id } }],
    bonds: [{ bondId: 'yanShip', layers: 7 }] };
  const owned = ownedPieces(priv, DATA.chess);
  assert.deepEqual(owned.map((o) => o.value), ['4', '9']);
  assert.notEqual(owned[0].name, owned[1].name, 'a repeated name is numbered');
  assert.ok(tokenOptions(id, DATA.chess, DATA.tokens).length >= 1);
  assert.equal(currentLayers(priv, 'yanShip'), 7);
  assert.equal(currentLayers(priv, 'none'), 0);
  assert.deepEqual(consoleCommands(false), ['funds', 'chess', 'item', 'token', 'bond', 'bounty', 'strategy', 'lp', 'level']);
  assert.deepEqual(consoleCommands(true).slice(-3), ['round', 'hp', 'teamLp']);
});

test('the console log reads in words', () => {
  const names = (table, id) => ({ chess: { c1: '能天使' }, enemies: { e1: '源石虫' }, bonds: { b1: '炎' } }[table]?.[id] ?? id);
  assert.equal(consoleCommandText({ cmd: 'funds', args: { amount: 777 } }, names), '资金 → 777');
  assert.equal(consoleCommandText({ cmd: 'chess', args: { id: 'c1' } }, names), '干员 能天使');
  assert.equal(consoleCommandText({ cmd: 'bounty', args: { enemyKey: 'e1', count: 13 } }, names), '加入敌人 源石虫 ×13');
  assert.equal(consoleCommandText({ cmd: 'bounty', args: { enemyKey: 'e1' } }, names), '加入敌人 源石虫 ×1');
  assert.equal(consoleCommandText({ cmd: 'bond', args: { id: 'b1', layers: 10 } }, names), '盟约 炎 → 10 层');
  assert.equal(consoleCommandText({ cmd: 'bond', args: { id: 'b1', layers: 10, count: 2 } }, names), '盟约 炎 → 10 层 · 额外人数 2');
  assert.equal(consoleCommandText({ cmd: 'timers', args: { on: false } }, names), '计时 → 关闭');
  assert.equal(consoleCommandText({ cmd: 'round', args: { rejected: true } }, names), '回合');
  const line = consoleLogText({ seq: 3, playerId: 'p', at: 61000, cmd: 'funds', args: { amount: 5 }, ok: true }, '博士', names);
  assert.equal(line, '3 博士 00:01:01 资金 → 5 成功');
  const bad = consoleLogText({ seq: 4, playerId: 'p', at: 0, cmd: 'round', args: { rejected: true }, ok: false, code: 'TEST_FORBIDDEN', detail: 'shared' }, '博士', names);
  assert.match(bad, /回合 有其他博士在场时不能使用影响整局的指令$/);
});

import { dockHome, DOCK_REM } from '../public/js/ui/testDock.js';

test('the console dock reaches down to just above the shop bar', () => {
  const size = { width: 1280, height: 720 };
  const plain = dockHome(size, DOCK_REM), tall = dockHome(size, DOCK_REM, { tall: true });
  assert.equal(tall.y, plain.y);
  assert.ok(tall.height > plain.height + 100, `${tall.height} > ${plain.height}`);
  assert.ok(Math.abs(tall.y + tall.height - (720 - (DOCK_REM.shopTop + DOCK_REM.margin) * plain.rem)) < 0.01);
  assert.equal(dockHome({ width: 667, height: 375 }, DOCK_REM, { tall: true }).sheet, true);
});
