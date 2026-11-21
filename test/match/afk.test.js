// 挂机移出 (the AFK rule, server/match/Match.js afkRemoveRounds): a human seat of a match that started with ≥ 2 humans and
// sends no accepted substantive intent (common.js AFK_ACTIONS) for that many rounds in a row is removed as the prep that
// completes them ends — before the round's battle — exactly like a g.leave: m.removed to it, m.notice afkRemoved to
// everyone else in the match, then onLeave (copies back to the pool, status 'left', no battle, no boss-pool share).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, ERR, EMOTES } from '../../shared/constants.js';
import { Match, AFK_REMOVE_ROUNDS } from '../../server/match/Match.js';
import { AFK_ACTIONS } from '../../server/match/match/common.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { C2S } from '../../shared/protocol.js';
import { LOBBY_DEFAULTS } from '../../server/lobby.js';
import { bossPoolHp } from '../../server/match/finalAssault.js';
import { DATA, makeMatch, checkInvariants, give } from './harness.js';
import { getVersionData } from '../../server/data.js';
import { setGameData } from '../../server/sim/content/support/index.js';
import { beginCommandPrep, commandView } from '../../server/match/bandCommands.js';

const ACT3 = getVersionData('act3autochess@V3_1');

/**
 * Drive the humans until `pred` holds. A human `acts(ps)` confirms, picks in both drafts, toggles the shop freeze (a
 * substantive intent) once per prep and readies; any other one only sends what never counts — g.infoReady, g.bandFocus,
 * g.emote, g.unitStats, g.watch, g.ready — so its draft turns and preps run out on their timers. Seats the AI plays
 * (AI 托管) are left to the bot, disconnected ones send nothing. `send(ps)`: an extra intent a seat sends once per
 * phase and round (before it readies), which must be accepted — null for none.
 */
function drive(h, pred, acts = () => false, { maxSteps = 3e6, bandOf = () => null, send = () => null } = {}) {
  const m = h.m, done = new Set();
  for (let i = 0; i < maxSteps; i++) {
    if (pred() || h.ended) return pred();
    for (const ps of m.players.values()) {
      if (ps.isBot || ps.left || ps.botControlled || !ps.connected) continue;
      const id = ps.playerId, active = acts(ps), key = `${m.phase}:${m.round}:${id}`;
      if (m.phase === PHASE.INFO_CHECK && !ps.infoReady) m.handle(id, { t: 'g.infoReady' });
      const bandDue = m.draft?.concurrent ? m.draft.order.includes(id) && !m.draft.picks[id] : m.draftTurn() === id;
      if (m.phase === PHASE.BAND_DRAFT && bandDue && !done.has(key)) {
        done.add(key);
        const band = bandOf(ps) ?? m.gd.bandIds().find((b) => m.gd.bandAllowed(b) && !m.bandTaken(b, id));
        assert.deepEqual(m.handle(id, { t: active ? 'g.band' : 'g.bandFocus', bandId: band }), { ok: true });
      }
      // 选择自编 (CUSTOM_CHECK): every version since 2026-11-21 — g.diyBring counts (AFK_ACTIONS): only an acting human
      // confirms (brings none); an idle one waits out the step's countdown (untimed for a lone human, who acts there)
      if (m.phase === PHASE.CUSTOM_CHECK && active && ps.diyBring == null) assert.deepEqual(m.handle(id, { t: 'g.diyBring', slots: [] }), { ok: true });
      if (m.phase === PHASE.SP_DRAFT && m.spTurn() === id && active) {
        const idx = m.sp.cards.find((c) => m.spCardAvailable(c))?.idx;
        if (idx != null) m.handle(id, { t: 'g.choice', idx });
      }
      if (!done.has(`send:${key}`) && !(m.phase === PHASE.PREP && ps.ready)) {
        done.add(`send:${key}`);
        const extra = send(ps);
        if (extra) assert.deepEqual(m.handle(id, extra), { ok: true }, `${id} ${extra.t} in ${m.phase} R${m.round}`);
      }
      if (m.phase === PHASE.PREP && ps.alive && !ps.ready) {
        if (!done.has(key)) {
          done.add(key);
          if (active) assert.deepEqual(m.handle(id, { t: 'g.freeze' }), { ok: true });
          else {
            m.handle(id, { t: 'g.emote', id: EMOTES[0] });
            m.handle(id, { t: 'g.unitStats', seq: 1 });
            m.handle(id, { t: 'g.watch', fieldId: `n:${id}` });
          }
        }
        if (active && ps.personalChoice) m.handle(id, { t: 'g.choice', idx: 0, choiceId: ps.personalChoice.id });
        if (!ps.tempEmpty) ps.resolveTemp(); // what the deadline does, not an intent
        m.handle(id, { t: 'g.ready', ready: true });
      }
    }
    if (pred()) return true;
    if (!h.sched.runNext()) return pred();
  }
  return pred();
}
const reach = (h, phase, round, acts, opts) => {
  assert.ok(drive(h, () => h.m.phase === phase && h.m.round === round, acts, opts), `expected ${phase} R${round}, got ${h.m.phase} R${h.m.round}${h.ended ? ' (ended)' : ''}`);
};
/** Record the match state at every m.removed / m.notice frame. */
const watchRemovals = (h) => {
  const seen = [];
  h.onSend.push((id, msg) => {
    if (msg.t === 'm.removed' || msg.t === 'm.notice') seen.push({ id, msg, phase: h.m.phase, round: h.m.round, fields: h.m.fields.length });
  });
  return seen;
};

test('the substantive intents are exactly the ones named by the rule, all of them real C2S intents', () => {
  assert.equal(AFK_REMOVE_ROUNDS, 2);
  assert.equal(LOBBY_DEFAULTS.afkRemoveRounds, AFK_REMOVE_ROUNDS, 'real rooms get the default');
  assert.deepEqual([...AFK_ACTIONS].sort(), ['g.band', 'g.bandCancel', 'g.bandHold', 'g.bandLock', 'g.bandSkip', 'g.buy', 'g.choice', 'g.command', 'g.commandChoice',
    'g.destroy', 'g.diyBring', 'g.equip', 'g.freeze', 'g.levelUp', 'g.move', 'g.refresh', 'g.revive', 'g.reward', 'g.sell']);
  for (const t of AFK_ACTIONS) assert.ok(Object.hasOwn(C2S, t), t);
  for (const t of ['g.ready', 'g.emote', 'g.watch', 'g.unitStats', 'g.pause', 'g.infoReady', 'g.art', 'g.bandFocus', 'g.autoplay',
    'g.rerollVote', 'g.kickVote', 'g.kickBallot', 'g.bondPlan', 'g.leave', 'b.progress', 'b.result']) assert.ok(!AFK_ACTIONS.has(t), t);
  // the Match option: default 2, 0 turns the rule off, anything else keeps the default
  const base = { mode: 'coop', difficulty: 'NORMAL', seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }], data: DATA,
    scheduler: new VirtualScheduler(), send: () => true, broadcast: () => {}, onEnd: () => {} };
  for (const [value, want] of [[undefined, 2], [0, 0], [1, 1], [3, 3], [-1, 2], [1.5, 2], ['2', 2]]) {
    const m = new Match({ ...base, afkRemoveRounds: value });
    assert.equal(m.afkRemoveRounds, want, String(value));
    m.dispose();
  }
});

test('idle for two rounds: removed as the second prep ends, before its battle — m.removed to it, m.notice to the rest', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, spectators: ['s_0'], seed: 41, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, idle = h.ps('p_2'), acts = (ps) => ps.playerId !== 'p_2';
  const seen = watchRemovals(h);
  reach(h, PHASE.COMBAT, 1, acts);
  assert.equal(idle.afkRounds, 1, 'confirming, the highlighted strategy, emotes, stats, watching and Ready do not count');
  assert.deepEqual([h.ps('p_0').afkRounds, h.ps('p_1').afkRounds], [0, 0]);
  assert.ok(!idle.left && m.fields.some((f) => f.fieldId === 'n:p_2'), 'one idle round: the seat still fights');
  reach(h, PHASE.PREP, 2, acts);
  assert.equal(seen.length, 0);
  reach(h, PHASE.COMBAT, 2, acts);
  const removed = seen.filter((s) => s.msg.t === 'm.removed');
  assert.deepEqual(removed.map((s) => [s.id, s.msg]), [['p_2', { t: 'm.removed', reason: 'afk', rounds: 2 }]]);
  assert.deepEqual([removed[0].phase, removed[0].round, removed[0].fields], [PHASE.PREP, 2, 0], 'removed while the prep ends, before any battle exists');
  const notices = seen.filter((s) => s.msg.t === 'm.notice');
  assert.deepEqual(notices.map((s) => s.id).sort(), ['p_0', 'p_1', 's_0'], 'everyone else in the match, the spectator seat included');
  for (const s of notices) assert.deepEqual(s.msg, { t: 'm.notice', kind: 'afkRemoved', playerId: 'p_2', name: 'P2', rounds: 2 });
  // like a quitter: out of the match, status left, no battle, intents refused
  assert.ok(idle.left && !idle.alive);
  assert.equal(idle.eliminatedRound, 2);
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_2').status, 'left');
  assert.deepEqual(m.fields.map((f) => f.fieldId).sort(), ['n:p_0', 'n:p_1']);
  assert.deepEqual(m.handle('p_2', { t: 'g.ready', ready: true }), { error: ERR.NOT_IN_ROOM });
  assert.ok(h.bc.some((x) => x.t === 'm.ticker' && x.text.includes('P2')), 'the quit ticker line');
  assert.equal(h.ended, null, 'the others play on');
  checkInvariants(m);
  reach(h, PHASE.PREP, 4, acts);
  assert.equal(seen.filter((s) => s.msg.t === 'm.removed').length, 1, 'removed once');
  m.dispose();
});

test('an accepted substantive intent resets the count; refused ones do not', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 42, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, p1 = h.ps('p_1');
  const seen = watchRemovals(h);
  // p_1 acts only in the prep of round 2
  const acts = (ps) => ps.playerId === 'p_0' || (m.round === 2 && m.phase === PHASE.PREP);
  reach(h, PHASE.COMBAT, 1, acts);
  assert.equal(p1.afkRounds, 1);
  reach(h, PHASE.COMBAT, 2, acts);
  assert.equal(p1.afkRounds, 0, 'the shop freeze of round 2 reset it');
  reach(h, PHASE.PREP, 3, acts);
  assert.ok(m.handle('p_1', { t: 'g.sell', uid: 987654 }).error, 'an unknown piece is refused');
  assert.equal(m.handle('p_1', { t: 'g.band', bandId: 'band_bldsk' }).error, ERR.WRONG_PHASE);
  reach(h, PHASE.COMBAT, 3, acts);
  assert.equal(p1.afkRounds, 1, 'refused intents do not count');
  assert.ok(!p1.left);
  reach(h, PHASE.COMBAT, 4, acts);
  assert.ok(p1.left, 'the second idle round in a row');
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.removed').map((s) => [s.id, s.phase, s.round]), [['p_1', PHASE.PREP, 4]]);
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.notice').map((s) => s.id), ['p_0'], 'never to the bot');
  assert.equal(h.ps('ai_0').afkRounds, 0, 'AI seats are never counted');
  assert.ok(!h.ps('ai_0').left);
  m.dispose();
});

test('a seat under AI 托管 is never idle (offline too); neither is a disconnected human — it keeps its seat', () => {
  // both humans are offline for rounds below: the offline hold (test/match/offline-hold.test.js) is off so the match runs
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 43, fake: true, afkRemoveRounds: 2, offlineHoldMs: 0 }).start();
  const m = h.m, p0 = h.ps('p_0'), p1 = h.ps('p_1');
  // p_0 drops at once and plays the whole match under AI 托管
  m.onDisconnect('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.autoplay', on: true }), { ok: true });
  reach(h, PHASE.PREP, 2);
  assert.equal(p1.afkRounds, 1);
  // AI 托管 at the check resets the count (g.autoplay itself is not a substantive intent)
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: true }), { ok: true });
  reach(h, PHASE.PREP, 3);
  assert.equal(p1.afkRounds, 0);
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: false }), { ok: true });
  m.onDisconnect('p_1');
  reach(h, PHASE.COMBAT, 3);
  assert.equal(p1.afkRounds, 0, 'offline is not idle (the reconnect window decides, not the AFK rule)');
  reach(h, PHASE.COMBAT, 5);
  assert.ok(!p1.left && p1.afkRounds === 0, 'offline without AI 托管: the seat is kept through several preps');
  assert.ok(!p0.left && p0.afkRounds === 0, 'the AI 托管 seat never counts');
  assert.ok(!h.ps('ai_0').left);
  assert.equal(h.ended, null);
  // back online and still idle: counted again from 0, warned, then removed as usual
  m.onReconnect('p_1');
  reach(h, PHASE.COMBAT, 6);
  assert.equal(p1.afkRounds, 1);
  reach(h, PHASE.COMBAT, 7);
  assert.ok(p1.left, 'idle online after the reconnect: removed like any human');
  assert.ok(!p0.left);
  m.dispose();
});

test('an idle round before a drop does not carry over: the count restarts after the reconnect', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 45, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, p1 = h.ps('p_1');
  const toasts = [];
  h.onSend.push((id, msg) => { if (msg.t === 'm.toast' && id === 'p_1') toasts.push(msg); });
  reach(h, PHASE.COMBAT, 1, (ps) => ps.playerId !== 'p_1');
  assert.equal(p1.afkRounds, 1);
  assert.equal(toasts.length, 1);
  m.onDisconnect('p_1');
  reach(h, PHASE.COMBAT, 3, (ps) => ps.playerId !== 'p_1');
  assert.ok(!p1.left);
  assert.equal(p1.afkRounds, 0);
  assert.equal(toasts.length, 1, 'an offline seat is not warned');
  m.onReconnect('p_1');
  reach(h, PHASE.COMBAT, 4, (ps) => ps.playerId !== 'p_1');
  assert.ok(!p1.left);
  assert.equal(p1.afkRounds, 1);
  m.dispose();
});

test('solo, a lone human with AI teammates and afkRemoveRounds 0 never remove anyone', () => {
  for (const o of [{ mode: 'solo', humans: 1 }, { mode: 'coop', humans: 1, bots: 2 }, { mode: 'coop', humans: 2, afkRemoveRounds: 0 }]) {
    const h = makeMatch({ seed: 44, fake: true, afkRemoveRounds: 2, ...o }).start();
    // untimed phases wait for the lone human's picks; in its preps it only readies
    const acts = (ps) => h.m.soloUntimed && (h.m.phase !== PHASE.PREP || !!ps.personalChoice);
    reach(h, PHASE.PREP, 4, acts);
    for (const ps of h.m.players.values()) {
      assert.ok(!ps.left, `${o.mode} ${ps.playerId}`);
      assert.equal(ps.afkRounds, 0, 'not even counted');
    }
    assert.ok(!h.sent.some(([, x]) => x.t === 'm.removed' || x.t === 'm.notice'));
    h.m.dispose();
  }
});

test('every human idle: each is removed like a quitter, the last one ends the match as abandoned before the battle', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 45, fake: true, afkRemoveRounds: 2 }).start();
  const seen = watchRemovals(h);
  const ended = drive(h, () => h.ended != null);
  assert.ok(ended);
  assert.equal(h.ended.reason, 'abandoned');
  assert.equal(h.endedCount, 1);
  assert.equal(h.m.round, 2);
  assert.ok(!h.m.fields.length, 'no round-2 battle was built');
  assert.deepEqual(seen.map((s) => [s.msg.t, s.id]), [['m.removed', 'p_0'], ['m.notice', 'p_1'], ['m.removed', 'p_1']]);
  h.m.dispose();
});

test('a seat removed in the boss round prep has no place in the Final Assault pairing or the boss pool', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 3, seed: 5, fake: true, afkRemoveRounds: 2,
    script: (b) => (b.kind === 'boss' ? { bossDps: 1e9 } : {}) }).start();
  const m = h.m;
  h.autoHumans();
  h.drive(() => m.phase === PHASE.PREP && m.round === 12);
  // from round 12 on p_2 plays itself: one shop freeze, then nothing; p_0 / p_1 stay under AI 托管
  assert.deepEqual(m.handle('p_2', { t: 'g.autoplay', on: false }), { ok: true });
  assert.deepEqual(m.handle('p_2', { t: 'g.freeze' }), { ok: true });
  const seen = watchRemovals(h);
  reach(h, PHASE.PREP, 14);
  assert.equal(h.ps('p_2').afkRounds, 1);
  assert.equal(m.bossWaves.length, 2, 'three players: a pair and a lone half');
  reach(h, PHASE.FINAL_ASSAULT, 14);
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.removed').map((s) => [s.id, s.phase, s.round]), [['p_2', PHASE.PREP, 14]]);
  assert.deepEqual(m.fields.map((f) => f.players), [['p_0', 'p_1']], 'one boss field for the two players left');
  assert.equal(m.bossPool.maxHp, bossPoolHp(m.gd, m.bossId, 2), 'the boss pool of the two players left');
  assert.equal(h.ps('p_2').eliminatedRound, 14);
  const end = h.runToEnd();
  assert.equal(end.victory, true);
  assert.equal(end.players.find((p) => p.playerId === 'p_2').roundsPassed, 13);
  m.dispose();
});

test('one idle round short of the limit: a warn toast now, m.private afkWarn through the next prep, cleared by any real move', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 43, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, idle = h.ps('p_1');
  const toasts = [];
  h.onSend.push((id, msg) => { if (msg.t === 'm.toast' && id === 'p_1') toasts.push(msg); });
  reach(h, PHASE.COMBAT, 1, (ps) => ps.playerId !== 'p_1');
  assert.equal(idle.afkRounds, 1);
  assert.equal(toasts.length, 1, 'warned once, as the idle prep ends');
  assert.equal(toasts[0].kind, 'warn');
  assert.equal(h.ps('p_0').privateView().afkWarn, undefined, 'the active seat is never flagged');
  reach(h, PHASE.PREP, 2, (ps) => ps.playerId !== 'p_1');
  assert.equal(idle.privateView().afkWarn, true, 'the next prep shows the warning');
  assert.deepEqual(m.handle('p_1', { t: 'g.freeze' }), { ok: true });
  assert.equal(idle.privateView().afkWarn, undefined, 'a substantive intent clears it at once');
  m.dispose();
});

test('no warning when the rule is off or only one idle round removes', () => {
  for (const afkRemoveRounds of [0, 1]) {
    const h = makeMatch({ mode: 'coop', humans: 2, seed: 44, fake: true, afkRemoveRounds }).start();
    const toasts = [];
    h.onSend.push((id, msg) => { if (msg.t === 'm.toast' && id === 'p_1') toasts.push(msg); });
    reach(h, PHASE.COMBAT, 1, (ps) => ps.playerId !== 'p_1');
    assert.equal(toasts.length, 0, String(afkRemoveRounds));
    assert.equal(h.ps('p_1').privateView().afkWarn, undefined);
    h.m.dispose();
  }
});

test('老鲤【得闲饮茶】: rounds 1–2 leave the seat nothing to do and are no idle rounds; from round 3 it counts as usual (feedback #164)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 46, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, lee = h.ps('p_1');
  const warned = [];
  h.onSend.push((id, msg) => { if (msg.t === 'm.toast' && msg.kind === 'warn' && id === 'p_1') warned.push(m.round); });
  const seen = watchRemovals(h);
  const acts = (ps) => ps.playerId !== 'p_1';
  // p_1 only highlights 老鲤 and lets its turn run out (no substantive intent), then sends nothing that counts
  const opts = { bandOf: (ps) => (ps.playerId === 'p_1' ? 'band_lmlee' : m.gd.bandIds().find((b) => b !== 'band_lmlee' && m.gd.bandAllowed(b) && !m.bandTaken(b, ps.playerId))) };
  for (const r of [1, 2]) {
    reach(h, PHASE.PREP, r, acts, opts);
    assert.equal(lee.bandId, 'band_lmlee');
    assert.equal(lee.funds, 0, `R${r}: the funds wait for round 3`);
    assert.equal(lee.afkCanAct(), false, `R${r}: nothing to buy, refresh, level up or move`);
    assert.equal(lee.privateView().afkWarn, undefined);
    reach(h, PHASE.COMBAT, r, acts, opts);
    assert.equal(lee.afkRounds, 0, `R${r} is no idle round`);
  }
  assert.deepEqual(warned, [], 'no warning for rounds 1–2 (until now: warned after R1, removed after R2)');
  reach(h, PHASE.PREP, 3, acts, opts);
  assert.ok(lee.funds > 0 && lee.afkCanAct(), 'R3: the held funds and the two operators');
  reach(h, PHASE.COMBAT, 3, acts, opts);
  assert.equal(lee.afkRounds, 1, 'an idle R3 counts');
  assert.deepEqual(warned, [3]);
  assert.ok(!lee.left);
  reach(h, PHASE.COMBAT, 4, acts, opts);
  assert.ok(lee.left, 'two idle rounds it could have played, R3 and R4: removed');
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.removed').map((s) => [s.id, s.round]), [['p_1', 4]]);
  m.dispose();
});

test('afkCanAct: no funds for anything and nothing owned is nothing to do; a piece, an offer, a choice or a paid shop action is something', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 47, fake: true }).start();
  h.toPrep(1);
  const m = h.m, ps = h.ps('p_1');
  const empty = () => {
    ps.funds = 0; ps.shop.freeRefreshes = 0; ps.shop.upgradePrice = 99; ps.offers = []; ps.personalChoice = null;
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
  };
  empty();
  assert.equal(ps.afkCanAct(), false);
  ps.funds = m.gd.refreshPrice;
  assert.ok(m.gd.refreshPrice > 0 && ps.afkCanAct(), 'a paid refresh');
  empty(); ps.shop.freeRefreshes = 1;
  assert.ok(ps.afkCanAct(), 'a free refresh');
  empty();
  const slot = ps.shop.slots.find((s) => s && !s.sold), price = slot.basePrice;
  slot.basePrice = 0;
  assert.ok(ps.priceOf(slot) === 0 && ps.afkCanAct(), 'a card it can pay (a free one: no funds for a refresh)');
  slot.basePrice = price;
  empty(); ps.shop.upgradePrice = 0;
  assert.ok(ps.shop.level < m.gd.maxShopLevel && ps.afkCanAct(), 'a free level-up');
  empty();
  give(m, ps, Object.keys(DATA.chess).find((id) => DATA.chess[id].tier === 1 && !DATA.chess[id].isGolden && !DATA.chess[id].isDiy));
  assert.ok(ps.afkCanAct(), 'a piece to move or sell');
  empty(); ps.offers = [{ source: 'merge', ids: [] }];
  assert.ok(ps.afkCanAct(), 'a reward offer');
  empty(); ps.personalChoice = { id: 'x', cards: [] };
  assert.ok(ps.afkCanAct(), 'a personal choice');
  empty();
  m.dispose();
});

test('规程: a 指令 (g.command) each prep keeps a seat playing; 选择自编 (g.diyBring) counts for the first check (the owner 2026-11-16)', (t) => {
  setGameData(ACT3);
  t.after(() => setGameData(null));
  const h = makeMatch({ data: ACT3, mode: 'coop', humans: 3, seed: 48, fake: true, afkRemoveRounds: 2 }).start();
  t.after(() => h.m.dispose());
  const m = h.m, cmd = h.ps('p_1'), diy = h.ps('p_2');
  const seen = watchRemovals(h);
  const acts = (ps) => ps.playerId === 'p_0';
  // p_1 highlights 天空盒 (【内部货源】: a free NO_TARGET 指令, once a round) and only uses it; p_2 only confirms 选择自编
  // (bringing none) — neither sends anything else that counts
  const bandOf = (ps) => ({ p_1: 'band_price', p_2: 'band_fund' })[ps.playerId]
    ?? m.gd.bandIds().find((b) => !['band_price', 'band_fund'].includes(b) && m.gd.bandAllowed(b) && !m.bandTaken(b, ps.playerId));
  const send = (ps) => {
    if (ps === cmd && m.phase === PHASE.PREP) return { t: 'g.command', effectId: ps.command.currentEffectId, target: {} };
    if (ps === diy && m.phase === PHASE.CUSTOM_CHECK) return { t: 'g.diyBring', slots: [] };
    return null;
  };
  const opts = { bandOf, send };
  reach(h, PHASE.COMBAT, 1, acts, opts);
  assert.equal(cmd.bandId, 'band_price');
  assert.equal(cmd.command?.currentEffectId, 'aceffect_band_73');
  assert.ok(cmd.command.records.aceffect_band_73.totalUsed >= 1, 'the 指令 was used');
  assert.deepEqual(diy.diyBring, [], '选择自编 confirmed: brings none');
  assert.deepEqual([cmd.afkRounds, diy.afkRounds], [0, 0], 'a 指令 and 选择自编 are substantive (until now: both 1)');
  reach(h, PHASE.COMBAT, 2, acts, opts);
  assert.deepEqual([cmd.afkRounds, diy.afkRounds], [0, 1], 'R2: the 指令 again; 选择自编 was before the first check only');
  assert.ok(!cmd.left && !diy.left);
  reach(h, PHASE.COMBAT, 3, acts, opts);
  assert.ok(diy.left, 'idle in R2 and R3: removed');
  assert.ok(!cmd.left && cmd.afkRounds === 0, 'a 指令 every prep: never idle');
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.removed').map((s) => [s.id, s.round]), [['p_2', 3]]);
  assert.equal(h.ps('p_0').afkRounds, 0);
});

test('afkCanAct counts a 规程 指令 it could use now: a free one is something; used up, passive (老鲤) or none is nothing', (t) => {
  setGameData(ACT3);
  t.after(() => setGameData(null));
  const h = makeMatch({ data: ACT3, mode: 'coop', humans: 2, seed: 49, fake: true }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  const ps = h.ps('p_1');
  const empty = (bandId) => {
    ps.bandId = bandId; ps.command = null; beginCommandPrep(ps);
    ps.funds = 0; ps.shop.freeRefreshes = 0; ps.shop.upgradePrice = 99; ps.offers = []; ps.personalChoice = null;
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
    for (const slot of ps.shop.slots) if (slot) slot.sold = true;
  };
  empty('band_price');
  assert.equal(commandView(ps).reason, null);
  assert.ok(ps.afkCanAct(), '天空盒: a free 指令 with uses left');
  ps.ready = true;
  assert.ok(ps.afkCanAct(), 'readied (as every seat is at the check): still something it could have done');
  ps.ready = false;
  ps.command.records.aceffect_band_73.used = 1;
  assert.equal(commandView(ps).reason, 'exhausted');
  assert.equal(ps.afkCanAct(), false, 'used up this round');
  empty('band_lmlee');
  assert.equal(commandView(ps).reason, 'passive');
  assert.equal(ps.afkCanAct(), false, '老鲤【得闲饮茶】 is a passive 指令: rounds 1–2 stay nothing to do in 规程 too');
});
