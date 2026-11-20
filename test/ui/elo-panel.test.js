// ELO on the page (docs/history/0.4.0.md §37.275): the counts of the local records (ui/eloRecords.js) — the very counts
// room.elo sends, and only from a room with the option (ui/loadoutSync.js installEloSync) —, the player's own panel
// (ui/eloPanel.js: 此功能仅为娱乐, the own rate, its shrunk value or 记录不足, 帮 / 不调 / 压 and its level, what changes, the
// measured estimate, that it counts and updates), read through shared/elo.js eloImpact — the server's tilt's own mapping —,
// and the host's switch (ui/experimental.js eloRow: the reminder with the panel first). The browser: elo-room e2e shots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eloRecords } from '../../public/js/ui/eloRecords.js';
import { EloPanel, eloBrief, eloEffectText, eloLevelText, eloMine } from '../../public/js/ui/eloPanel.js';
import { ExperimentalDetails, eloRow, experimentalItems, experimentalOptions, groupRows, queueConfig } from '../../public/js/ui/experimental.js';
import { installEloSync, SYNC_DEBOUNCE_MS } from '../../public/js/ui/loadoutSync.js';
import { createStore } from '../../public/js/store.js';
import { ELO_LEVELS, eloImpact, eloKey, eloSummary, eloTilt, eloTrusted } from '../../shared/elo.js';
import { recordWon, roundsOf } from '../../public/js/ui/stats.js';
import { parseKeyring } from '../../server/identity.js';
import { createReceipts } from '../../server/resultReceipts.js';
import { randomBytes } from 'node:crypto';
import { eloTilt as serverTilt } from '../../server/match/tilt.js';

const walk = (node) => (Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : []);
const text = (node) => (Array.isArray(node) ? node.map(text).join('') : node == null || node === false ? ''
  : typeof node === 'object' ? text(node.props?.children) : String(node));
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
let seq = 0;
/** A counted settled record of mine (ui/stats.js shape: roomMode, difficulty, my own row; a loss after `rounds` rounds). */
const rec = (won, o = {}, rounds = 12) => ({ id: `r${++seq}`, end: 'settled', roomMode: 'solo', difficulty: 'ABYSS', selfId: 'me', victory: won,
  roundsPassed: won ? 14 : rounds, players: [{ playerId: 'me', victory: won, alive: won, roundsPassed: won ? 14 : rounds }], ...o });
const many = (wins, games, o, rounds) => Array.from({ length: games }, (_, i) => rec(i < wins, o, rounds));
// each version its own (the owner, 2026-11-20): these records name none, so they played 第二期下半
const K = (mode, difficulty) => eloKey(mode, difficulty, 'act2autochess');
// receipts (§37.276): help comes only from this identity's receipts — the panel's numbers below are of signed records
const SUB = 'S'.repeat(21) + 'A';
const RC = createReceipts({ keys: parseKeyring(`t1 ${randomBytes(32).toString('base64')}`) });
let rcSeq = 0;
const signed = (list) => list.map((r) => ({ ...r, rc: RC.issue({ sub: SUB, rec: String(++rcSeq).padStart(16, 'x'), mode: r.roomMode, diff: r.difficulty,
  ver: 'act2autochess', w: recordWon(r), rp: Math.round(roundsOf(r)), tr: 0, ai: false, mod: false, elo: false }) }));
const mineOf = (mode, difficulty, list) => eloMine(mode, difficulty, () => signed(list), SUB);

test('the lists: per mode:difficulty the newest 30 that count, [won, roundsPassed], a win my own row\'s', () => {
  assert.deepEqual(eloRecords([]), {});
  const list = [...many(3, 4), rec(true, { roomMode: 'coop', difficulty: 'HARD' }), rec(false, { test: true }), rec(true, { content: { cs: 'x', plugins: [] } }),
    rec(true, { difficulty: 'TRAINING' }), rec(true, { roomMode: null }), rec(true, { players: [{ playerId: 'me', victory: true, aiTakeoverRound: 3 }] }),
    rec(false, { end: 'quit', players: [{ playerId: 'me', alive: true, roundsPassed: 0 }] }), rec(false, { end: 'quit', players: [{ playerId: 'me', alive: false, roundsPassed: 3 }] })];
  assert.deepEqual(eloRecords(list), { [K('solo', 'ABYSS')]: [[1, 14], [1, 14], [1, 14], [0, 12], [0, 3]], [K('coop', 'HARD')]: [[1, 14]] },
    'test, plugin, training, AI 托管 and an early quit do not count; a later quit is a loss after its rounds');
  assert.equal(eloRecords([...many(30, 30), ...many(0, 10)])[K('solo', 'ABYSS')].length, 30, 'only the newest 30');
  // a teammate's win is not mine
  assert.deepEqual(eloRecords([rec(false, { victory: true, players: [{ playerId: 'me', victory: false, roundsPassed: 9 }, { playerId: 'x', victory: true }] })]), { [K('solo', 'ABYSS')]: [[0, 9]] });
});

test('the panel and the server run one computation; a few or quick records → 不调, a strong player → 压, a weak one → 帮', () => {
  for (let w = 0; w <= 30; w++) {
    const list = eloRecords(many(w, 30))[K('solo', 'ABYSS')];
    assert.deepEqual(mineOf('solo', 'ABYSS', many(w, 30)).tilt, serverTilt(list), `${w}/30`);
    // the local records alone: only a hindrance (the server takes them only for that)
    assert.deepEqual(eloMine('solo', 'ABYSS', () => many(w, 30), SUB).tilt, serverTilt(eloTrusted(list, []).entries), `${w}/30 unsigned`);
  }
  assert.equal(eloTilt, serverTilt, 'the server re-exports the shared function');
  const few = mineOf('solo', 'ABYSS', many(3, 4));
  assert.equal(few.key, 'few');
  assert.equal(eloLevelText(few), '不调');
  const fewText = text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: few }));
  assert.match(fewText, /此功能仅为娱乐/);
  assert.match(fewText, /最近 4 局第二期下半·独立·终极模拟：3 胜 1 负，胜率 75%/);
  assert.match(fewText, /按 4 局计/);
  assert.match(fewText, /折算后不足 5 局，暂不调整/);
  assert.match(fewText, /计入成就；胜率在每局结束后/);
  assert.doesNotMatch(fewText, /按实测/);
  // the owner's case: five quick losses are not full help — they weigh 2 of 10 rounds each
  const quick = mineOf('solo', 'ABYSS', many(0, 5, undefined, 2));
  assert.equal(quick.key, 'few');
  assert.match(text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: quick })), /0 胜 5 负.*按 1 局计/);
  const strong = mineOf('solo', 'ABYSS', many(18, 30, undefined, 7));
  assert.equal(strong.games, 26.4);
  assert.equal(strong.dir, 'hinder');
  assert.equal(eloLevelText(strong), '压 · 2 级', 'w (18+2)/(26.4+4) = 0.658: s −0.395');
  const s = text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: strong }));
  assert.match(s, /最近 30 局第二期下半·独立·终极模拟：18 胜 12 负，胜率 60%/);
  assert.match(s, /早期失利按通过的回合折算（通过 10 回合算 1 局），按 26.4 局计/);
  assert.match(s, /按 \+2 胜 \+2 负向 50% 折算：66%/);
  assert.match(s, /更难刷到/);
  const top = mineOf('coop', 'HARD', many(30, 30, { roomMode: 'coop', difficulty: 'HARD' }));
  assert.equal(eloLevelText(top), '压 · 4 级');
  assert.match(eloEffectText(top), /几乎刷不到/);
  const coop = text(EloPanel({ mode: 'coop', difficulty: 'HARD', revival: true, mine: top }));
  assert.match(coop, /取决于队友/);
  assert.match(coop, /AI 队友不会救你/);
  assert.match(text(EloPanel({ mode: 'coop', difficulty: 'HARD', revival: true, mine: mineOf('coop', 'HARD', many(22, 30, { roomMode: 'coop', difficulty: 'HARD' }, 14)) })),
    /AI 队友约有 49% 的可能救你/, '22 of 30, every loss full: s −0.515');
  assert.match(coop, new RegExp(`胜率约 ${ELO_LEVELS.measured.off}% → ${ELO_LEVELS.hinder[3].at}%`));
  const weak = mineOf('solo', 'ABYSS', many(2, 30));
  assert.equal(eloLevelText(weak), '帮 · 3 级');
  assert.match(eloEffectText(weak), /明显更容易刷到/);
  assert.equal(eloBrief(weak), '你：近期胜率 7% · 帮 · 3 级');
  assert.equal(eloBrief(few), '你：折算后不足 5 局，暂不调整');
  const none = text(EloPanel({ mode: 'solo', difficulty: 'NORMAL', mine: mineOf('solo', 'NORMAL', []) }));
  assert.match(none, /本机还没有第二期下半·独立·险境模拟的对局记录/);
  assert.equal(eloImpact(eloSummary([])).key, 'few');
});

test('ELO on the page: the 特殊功能 row of a private room, named in the rule list, never a ticket\'s', () => {
  assert.equal(experimentalOptions(rules({ elo: true })).elo, true);
  assert.equal(Object.hasOwn(queueConfig(rules({ elo: true })), 'elo'), false);
  assert.deepEqual(experimentalItems(rules({ elo: true })).map((x) => `${x.group}:${x.key}:${x.text}`), ['special:elo:ELO']);
  const ids = (rows) => walk(rows).map((n) => n.props.id).filter(Boolean);
  assert.ok(ids(groupRows('special', { value: rules(), mode: 'solo', source: 'private' })).includes('experimental-elo'));
  assert.equal(ids(groupRows('special', { value: rules(), source: 'matchmaking' })).includes('experimental-elo'), false);
  // the rule list's line is the reader's own, only with the room's difficulty
  const plain = walk(ExperimentalDetails({ value: rules({ elo: true }) }));
  assert.equal(plain.some((n) => n.props['data-testid'] === 'expd-elo-brief'), false);
  const own = walk(ExperimentalDetails({ value: rules({ elo: true }), mode: 'solo', difficulty: 'ABYSS' }));
  assert.ok(own.some((n) => n.props['data-testid'] === 'expd-elo-brief'));
});

test('the host\'s switch: off → on only after the reminder with the own panel; on → off at once', async () => {
  const sent = [];
  let asked = null, answer = false;
  const confirm = (room) => { asked = room; return Promise.resolve(answer); };
  const row = (value) => walk(eloRow({ value, source: 'private', mode: 'solo', difficulty: 'ABYSS', roomCode: 'ABCD', editable: true, busy: null,
    onChange: (x) => sent.push(x), confirm }))
    .find((n) => n.props.id === 'experimental-elo');
  const input = { checked: true };
  row(rules()).props.onChange({ currentTarget: input });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(asked, { mode: 'solo', difficulty: 'ABYSS', revival: false });
  assert.equal(input.checked, false, 'off until confirmed');
  assert.deepEqual(sent, [], 'cancelled: nothing sent');
  answer = true;
  input.checked = true;
  row(rules()).props.onChange({ currentTarget: input });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sent, [rules({ elo: true })]);
  row(rules({ elo: true })).props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent.at(-1), rules());
  assert.match(text(eloRow({ value: rules(), source: 'private' })), /此功能仅为娱乐/, 'the row\'s note says it');
});

function fakeNet() {
  const listeners = new Map();
  const net = {
    status: 'online', sent: [],
    on(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); return () => listeners.get(t).delete(fn); },
    emit(t, msg) { for (const fn of listeners.get(t) || []) fn(msg); },
    request(t, fields) { net.sent.push({ t, ...fields }); return Promise.resolve({ t: 'ok' }); },
  };
  return net;
}
function fakeTimers() {
  let now = 0, seq = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => q.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

test('room.elo goes out only from a room with the option: on entering it, as its host turns it on, as a match ends', async () => {
  const net = fakeNet(), T = fakeTimers();
  let records = many(3, 10);
  const app = createStore({ room: null });
  const s = installEloSync({ net, timers: T, target: createStore({ eloSync: 'idle', eloRev: 0 }), app, records: () => records });
  net.emit('welcome', {});
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.deepEqual(net.sent, [], 'outside a room: nothing');
  app.set({ room: { code: 'ABCD', mode: 'solo', difficulty: 'ABYSS', inMatch: false, experimental: rules() } });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.deepEqual(net.sent, [], 'a room without it: nothing');
  app.set({ room: { code: 'ABCD', mode: 'solo', difficulty: 'ABYSS', inMatch: false, experimental: rules({ elo: true }) } });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.deepEqual(net.sent, [{ t: 'room.elo', rec: eloRecords(records), rc: [] }]);
  assert.equal(net.sent[0].rec[K('solo', 'ABYSS')].length, 10);
  app.set({ room: { code: 'ABCD', mode: 'solo', difficulty: 'ABYSS', inMatch: true, experimental: rules({ elo: true }) } });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.equal(net.sent.length, 1, 'the same counts are not sent again');
  records = [rec(true), ...records];
  app.set({ room: { code: 'ABCD', mode: 'solo', difficulty: 'ABYSS', inMatch: false, experimental: rules({ elo: true }) } });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.deepEqual(net.sent.at(-1), { t: 'room.elo', rec: eloRecords(records), rc: [] }, 'a new record after the match');
  assert.equal(net.sent.at(-1).rec[K('solo', 'ABYSS')].length, 11);
  app.set({ room: null });
  app.set({ room: { code: 'WXYZ', mode: 'solo', difficulty: 'ABYSS', inMatch: false, experimental: rules() } });
  net.emit('welcome', {});
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.equal(net.sent.length, 2, 'another room without it: nothing');
  s.dispose();
});
