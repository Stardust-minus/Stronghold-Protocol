// ELO on the page (docs/history/0.4.0.md §37.275): the counts of the local records (ui/eloRecords.js) — the very counts
// room.elo sends, and only from a room with the option (ui/loadoutSync.js installEloSync) —, the player's own panel
// (ui/eloPanel.js: 此功能仅为娱乐, the own rate on one line or 记录不足, 帮 / 不调 / 压 and its level, what changes, the room's
// own version's measured change in points — shared/elo.js ELO_MEASURED —, that it counts and updates), read through
// shared/elo.js eloImpact — the server's tilt's own mapping —,
// and the host's switch (ui/experimental.js eloRow: the reminder with the panel first). The browser: elo-room e2e shots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eloRecords } from '../../public/js/ui/eloRecords.js';
import { EloPanel, eloBrief, eloEffectLines, eloLevelText, eloMine } from '../../public/js/ui/eloPanel.js';
import { ExperimentalDetails, eloRow, experimentalItems, experimentalOptions, groupRows, queueConfig } from '../../public/js/ui/experimental.js';
import { installEloSync, SYNC_DEBOUNCE_MS } from '../../public/js/ui/loadoutSync.js';
import { createStore } from '../../public/js/store.js';
import { ELO_LEVELS, ELO_MEASURED, eloImpact, eloKey, eloMeasured, eloSummary, eloTilt, eloTiltAt, eloTrusted } from '../../shared/elo.js';
import { versionById } from '../../shared/versions.js';
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

test('the panel reads the room\'s own list however many other mode × difficulty × version lists the browser has (2026-11-21)', () => {
  const V3 = 'act3autochess@V3_1';
  // records in every list of every version: more than room.elo's ELO_LIMITS.keys — the panel used to see none of them
  const all = ['act2autochess', 'act2autochess@V2_1', 'act1autochess', 'act1autochess@V1_1', V3].flatMap((version) => ['solo', 'coop']
    .flatMap((roomMode) => ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'].map((difficulty) => rec(true, { roomMode, difficulty, ...(version === 'act2autochess' ? {} : { version }) }))));
  const mine = eloMine('solo', 'ABYSS', () => [...many(5, 5, { version: V3 }), ...all], SUB, V3);
  assert.equal(mine.ownN, 6, 'the 规程 solo 终极 list: five wins and the one of the spread');
  assert.deepEqual([mine.dir, mine.level], ['hinder', 3]);
  assert.deepEqual(mine.tilt, serverTilt(eloTrusted(eloRecords([...many(5, 5, { version: V3 }), ...all])[eloKey('solo', 'ABYSS', V3)], []).entries), 'what the server takes');
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
  assert.match(fewText, /第二期下半·独立·终极模拟 最近 4 局：3 胜 1 负/);
  assert.match(fewText, /记录不足 5 局，暂不调整/);
  assert.match(fewText, /计入成就 · 每局结束后更新/);
  assert.doesNotMatch(fewText, /预计影响|实测|→/, 'too few: no impact section');
  // the owner's case: five quick losses are not full help — they weigh 2 of 10 rounds each
  const quick = mineOf('solo', 'ABYSS', many(0, 5, undefined, 2));
  assert.equal(quick.key, 'few');
  const quickText = text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: quick }));
  assert.match(quickText, /0 胜 5 负/);
  assert.match(quickText, /折算后不足 5 局，暂不调整/);
  const strong = mineOf('solo', 'ABYSS', many(18, 30, undefined, 7));
  assert.equal(strong.games, 26.4);
  assert.equal(strong.dir, 'hinder');
  assert.equal(eloLevelText(strong), '压 · 2 级', 'w (18+2)/(26.4+4) = 0.658: s −0.395');
  const s = text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: strong }));
  assert.match(s, /第二期下半·独立·终极模拟 最近 30 局：18 胜 12 负（早期失利按回合折算）→ 66%/, 'one line: the counts and the rate the server uses');
  assert.doesNotMatch(s, /按 \+2 胜/, 'the shrink is in the line\'s ⓘ, not a line of its own');
  const tips = walk(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: strong })).filter((n) => typeof n.props.text === 'string').map((n) => n.props.text);
  assert.ok(tips.some((x) => /通过 10 回合算 1 局），共按 26.4 局计；折算后满 5 局才调整，胜率再加 2 胜 2 负/.test(x)), 'the ⓘ explains the rate');
  assert.match(s, /^[^]*更难刷到：凑精锐的第三张/);
  assert.match(s, /机变和随机赠送也偏向不利/);
  // every loss after 10 rounds: no weighting, no note
  assert.match(text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: mineOf('solo', 'ABYSS', many(18, 30, undefined, 12)) })), /18 胜 12 负 → 59%/);
  const top = mineOf('coop', 'HARD', many(30, 30, { roomMode: 'coop', difficulty: 'HARD' }));
  assert.equal(eloLevelText(top), '压 · 4 级');
  assert.match(eloEffectLines(top).join('|'), /^几乎刷不到：.*\|其他相关的牌也更难刷到\|机变和随机赠送也偏向不利$/);
  const coop = text(EloPanel({ mode: 'coop', difficulty: 'HARD', revival: true, mine: top }));
  assert.match(coop, /AI 队友不会救你/);
  assert.match(text(EloPanel({ mode: 'coop', difficulty: 'HARD', revival: true, mine: mineOf('coop', 'HARD', many(22, 30, { roomMode: 'coop', difficulty: 'HARD' }, 14)) })),
    /AI 队友不一定救你（约 49%）/, '22 of 30, every loss full: s −0.515');
  // the measured change: the room's own version's row, in percentage points (no version: 第二期下半)
  const a2 = ELO_MEASURED.act2autochess, a3 = ELO_MEASURED['act3autochess@V3_1'];
  const pts = (v) => (v > 0 ? `\\+${v}` : v < 0 ? `−${-v}` : '±0');
  assert.match(coop, new RegExp(`实测：胜率约 ${pts(Math.round(a2.hinder[3].at - a2.off))} 个百分点（AI 代打独立模拟，同盟另看队友）`));
  const coop3 = text(EloPanel({ mode: 'coop', difficulty: 'HARD', version: 'act3autochess@V3_1', revival: true, mine: top }));
  assert.match(coop3, new RegExp(`实测：胜率约 ${pts(Math.round(a3.hinder[3].at - a3.off))} 个百分点`));
  // a change whose interval holds 0 says so: 第二期下半's 压 1 级 measured +0.7 (−5.7…+7.1)
  const mild = mineOf('solo', 'ABYSS', many(17, 30, undefined, 12));
  assert.equal(eloLevelText(mild), '压 · 1 级');
  assert.match(text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: mild })), /实测：胜率约 \+1 个百分点，在误差内（AI 代打）/);
  assert.match(text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', version: 'act3autochess@V3_1', mine: mild })), /实测：胜率约 −4 个百分点，在误差内（AI 代打）/);
  assert.doesNotMatch(coop3, /29\.3%/, 'never the AI\'s own rate on the panel itself (that is the ⓘ\'s)');
  assert.equal(walk(EloPanel({ mode: 'coop', difficulty: 'HARD', version: 'act1autochess', mine: top })).some((n) => n.props['data-testid'] === 'elo-estimate'), false,
    'a version without measurements: no measured line');
  const weak = mineOf('solo', 'ABYSS', many(2, 30));
  assert.equal(eloLevelText(weak), '帮 · 3 级');
  assert.match(eloEffectLines(weak)[0], /^明显更容易刷到：/);
  assert.match(text(EloPanel({ mode: 'solo', difficulty: 'ABYSS', mine: weak })), new RegExp(`实测：胜率约 ${pts(Math.round(a2.help[2].at - a2.off))} 个百分点（AI 代打）`));
  assert.equal(eloBrief(weak), '你：近期胜率 12% · 帮 · 3 级', 'the rate the tilt uses (w), as on the panel');
  assert.equal(eloBrief(few), '你：记录不足 5 局，暂不调整');
  assert.equal(eloBrief(quick), '你：折算后不足 5 局，暂不调整');
  const none = text(EloPanel({ mode: 'solo', difficulty: 'NORMAL', mine: mineOf('solo', 'NORMAL', []) }));
  assert.match(none, /第二期下半·独立·险境模拟：本机还没有记录/);
  assert.equal(eloImpact(eloSummary([])).key, 'few');
});

test('the measurements: one row per measured version, a number for every level, each level measured at its own tilt', () => {
  assert.ok(Object.keys(ELO_MEASURED).length >= 2);
  for (const [id, row] of Object.entries(ELO_MEASURED)) {
    assert.ok(versionById(id), id);
    assert.equal(row.help.length, ELO_LEVELS.help.length, id);
    assert.equal(row.hinder.length, ELO_LEVELS.hinder.length, id);
    for (const v of [row.off, ...[...row.help, ...row.hinder].map((x) => x.at)]) assert.ok(Number.isFinite(v) && v >= 0 && v <= 100, `${id} ${v}`);
    for (const x of [...row.help, ...row.hinder]) assert.ok(x.lo <= x.at - row.off + 0.1 && x.at - row.off - 0.1 <= x.hi, `${id} ${x.at}: the change inside its interval`);
    assert.equal(eloMeasured(id, 'hinder', 4).pp, Math.round(row.hinder[3].at - row.off));
    assert.equal(eloMeasured(id, 'hinder', 4).noise, false);
  }
  assert.deepEqual(eloMeasured(null, 'help', 1), eloMeasured('act2autochess', 'help', 1), 'a room without a version plays 第二期下半');
  assert.equal(eloMeasured('act1autochess', 'help', 1), null);
  assert.equal(eloMeasured('act2autochess', 'none', 0), null);
  assert.equal(eloMeasured('__proto__', 'help', 1), null);
  // the arms the table was measured with (docs/history/0.4.0.md §37.275): the tilt the mapping gives at each level's w
  assert.deepEqual(ELO_LEVELS.help.map((r) => eloTiltAt(r.w)), [{ s: 0.165, m: 8 }, { s: 0.5, m: 8 }, { s: 1, m: 8 }]);
  assert.deepEqual(ELO_LEVELS.hinder.map((r) => eloTiltAt(r.w)), [{ s: -0.167, m: 4 }, { s: -0.5, m: 4 }, { s: -0.875, m: 4, floor: 0, mix: 0.5 }, { s: -1, m: 4, floor: 0, mix: 1 }]);
  // each level's w lands on its own level
  for (const dir of ['help', 'hinder']) {
    for (const r of ELO_LEVELS[dir]) assert.equal(eloImpact({ n: 30, wins: 0, games: 30, w: r.w, tilt: eloTiltAt(r.w) }).level, r.level, `${dir} ${r.level}`);
  }
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
  assert.deepEqual(asked, { mode: 'solo', difficulty: 'ABYSS', version: null, revival: false });
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
