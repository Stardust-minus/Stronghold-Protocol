// The room option "an AI seat's strategy" (room.setBotBand → opts.seats[].band of an AI seat): in the strategy draft
// (BAND_DRAFT) the designated AI seat takes exactly that strategy on its turn, whatever the order (and with 「AI 队友最后
// 选择」 on or off); until then the strategy is held for it — a human cannot pick it, and a timed-out turn, the AI's pick
// for a departing seat or the end-of-draft defaults skip it. m.public draft.reserved lists the strategies still held. Without a
// designation (or with one the match cannot honour) the draft is exactly today's. Expanded-capacity rooms allow
// repeats: nothing is held there, the AI seat still takes its strategy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

const isAi = (pid) => pid.startsWith('ai_');
/** seats in the given order; `bands` = { playerId: band } for the AI seats the host designated */
const seatsOf = (ids, bands = {}) => ids.map((playerId, seat) => ({ seat, playerId, name: playerId, isBot: isAi(playerId), connected: true,
  ...(Object.hasOwn(bands, playerId) ? { band: bands[playerId] } : {}) }));
const CAP8 = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 };

/** A match driven to BAND_DRAFT (every human confirms the briefing); `before(m)` runs while still in INFO_CHECK. */
function toBandDraft(o, before) {
  const h = makeMatch({ mode: 'coop', ...o }).start();
  if (before) before(h.m);
  for (const ps of h.m.players.values()) if (!ps.isBot && !ps.left) h.m.handle(ps.playerId, { t: 'g.infoReady' });
  h.run(() => h.m.phase !== PHASE.INFO_CHECK);
  assert.equal(h.m.phase, PHASE.BAND_DRAFT);
  return h;
}

/**
 * Run the whole draft; on a human's turn `pick(m, pid)` names its band (default: the first strategy free for it).
 * Returns the picks, the m.public drafts seen and the next draws of the random streams.
 */
function runDraft(o, pick) {
  const h = toBandDraft(o);
  const m = h.m;
  const views = [];
  for (let i = 0; i < 64 && m.phase === PHASE.BAND_DRAFT; i++) {
    views.push(m.publicView().draft);
    const pid = m.draftTurn();
    if (pid && !m.players.get(pid).botControlled) {
      const id = pick ? pick(m, pid) : m.gd.bandIds().find((b) => !m.bandTaken(b, pid));
      assert.deepEqual(m.handle(pid, { t: 'g.band', bandId: id }), { ok: true }, `${pid} picks ${id}`);
    }
    h.run(() => m.phase !== PHASE.BAND_DRAFT || (m.draftTurn() != null && !m.players.get(m.draftTurn()).botControlled));
  }
  assert.notEqual(m.phase, PHASE.BAND_DRAFT, 'the draft ended');
  const r = { picks: { ...m.draft.picks }, views, draws: { draft: m.rngDraft(), bots: m.rngBots(), shop: m.rngShop(), meta: m.rngMeta() },
    lp: Object.fromEntries([...m.players.values()].map((ps) => [ps.playerId, ps.lp])) };
  m.dispose();
  return r;
}

test('no designation, null, or one the match cannot honour: the draft is exactly today\'s (no reserved field)', () => {
  const ids = ['p_0', 'ai_0', 'ai_1', 'ai_2'];
  for (let seed = 1; seed <= 6; seed++) {
    for (const aiPicksLast of [false, true]) {
      const base = runDraft({ seats: seatsOf(ids), seed, aiPicksLast });
      assert.ok(base.views.every((d) => !Object.hasOwn(d, 'reserved')), 'no designation: m.public draft unchanged');
      for (const bands of [{ ai_0: null }, { ai_0: 'band_nope' }, { ai_1: '' }, { p_0: 'band_amiya' }]) {
        const r = runDraft({ seats: seatsOf(ids, bands), seed, aiPicksLast });
        assert.deepEqual(r, base, `seed ${seed} aiPicksLast ${aiPicksLast} ${JSON.stringify(bands)}`);
      }
    }
  }
});

test('the designated AI seats take exactly their strategies in any draft order, with 「AI 队友最后选择」 off and on', () => {
  const bands = { ai_0: 'band_bldsk', ai_1: 'band_amiya' };
  let humanBeforeAi = 0, aiBeforeHuman = 0;
  for (let seed = 1; seed <= 12; seed++) {
    for (const aiPicksLast of [false, true]) {
      const h = toBandDraft({ seats: seatsOf(['ai_0', 'p_0', 'ai_1', 'ai_2'], bands), seed, aiPicksLast });
      const m = h.m;
      assert.deepEqual([...m.botBands], [['ai_0', 'band_bldsk'], ['ai_1', 'band_amiya']]);
      const order = m.draft.order.slice();
      if (aiPicksLast) assert.equal(order[0], 'p_0');
      h.run(() => m.draftTurn() === 'p_0');
      // whatever the AI seats before the human picked, the designated strategies are never the human's
      for (const [ai, id] of Object.entries(bands)) {
        if (m.draft.picks[ai]) { assert.equal(m.draft.picks[ai], id, `seed ${seed}: ${ai} picked before the human`); aiBeforeHuman++; continue; }
        humanBeforeAi++;
        assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: id }), { error: ERR.BAD_TARGET, detail: '队友已选' }, `seed ${seed}: ${id} is held for ${ai}`);
      }
      const mine = m.gd.bandIds().find((b) => !m.bandTaken(b, 'p_0'));
      assert.ok(mine && !Object.values(bands).includes(mine));
      assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: mine }), { ok: true });
      h.run(() => m.phase !== PHASE.BAND_DRAFT);
      assert.equal(m.draft.picks.ai_0, 'band_bldsk', `seed ${seed} aiPicksLast ${aiPicksLast}: ${order}`);
      assert.equal(m.draft.picks.ai_1, 'band_amiya');
      assert.equal(m.players.get('ai_0').bandId, 'band_bldsk');
      assert.equal(m.players.get('ai_1').lp, m.gd.startLp('band_amiya'));
      assert.equal(new Set(Object.values(m.draft.picks)).size, 4, 'no duplicate strategy');
      assert.ok(!['band_bldsk', 'band_amiya', mine].includes(m.draft.picks.ai_2), 'the undesignated AI picks among the free ones');
      m.dispose();
    }
  }
  assert.ok(humanBeforeAi > 0 && aiBeforeHuman > 0, 'both orders were exercised');
});

test('m.public draft.reserved: bandId → AI playerId while held, emptied as the AI seats pick; other fields unchanged', () => {
  const ids = ['p_0', 'ai_0', 'ai_1', 'ai_2'];
  const bands = { ai_0: 'band_bldsk', ai_2: 'band_sarkazb' };
  const h = toBandDraft({ seats: seatsOf(ids, bands), seed: 3, aiPicksLast: true });
  const m = h.m;
  const d = m.publicView().draft;
  assert.deepEqual(d.reserved, { band_bldsk: 'ai_0', band_sarkazb: 'ai_2' });
  assert.deepEqual(Object.keys(d).sort(), ['order', 'picks', 'reserved', 'skipsLeft', 'turn', 'turnDeadline', 'turnSeconds', 'untimed']);
  m.flush(true);
  assert.deepEqual(h.lastBc('m.public').draft.reserved, { band_bldsk: 'ai_0', band_sarkazb: 'ai_2' }, 'the broadcast carries it');
  assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
  h.run(() => m.phase !== PHASE.BAND_DRAFT || Object.keys(m.draft.picks).length === 4);
  assert.deepEqual(m.reservedBands(), {});
  assert.deepEqual(m.draft.picks.ai_0, 'band_bldsk');
  assert.deepEqual(m.draft.picks.ai_2, 'band_sarkazb');
  m.dispose();
  // the client's view of the draft without a designation keeps its exact key set
  const plain = toBandDraft({ seats: seatsOf(ids), seed: 3, aiPicksLast: true });
  assert.deepEqual(Object.keys(plain.m.publicView().draft).sort(), ['order', 'picks', 'skipsLeft', 'turn', 'turnDeadline', 'turnSeconds', 'untimed']);
  plain.m.dispose();
});

test('automatic assignments skip a held strategy: a timed-out turn (highlight and default), a departing seat, the draft\'s end', () => {
  const bands = { ai_0: 'band_bldsk', ai_1: 'band_amiya' };
  // timeout (two humans: a timed draft): the highlighted strategy is held → the default 华法琳 is held too → the first
  // free one (杜遥夜)
  {
    const h = toBandDraft({ seats: seatsOf(['p_0', 'ai_0', 'p_1', 'ai_1'], bands), seed: 5, aiPicksLast: true });
    const m = h.m;
    const [first, second] = m.draft.order;
    assert.ok(!isAi(first) && !isAi(second) && m.draft.turnDeadline > 0, 'humans first, timed');
    assert.deepEqual(m.handle(first, { t: 'g.bandFocus', bandId: 'band_amiya' }), { ok: true }, 'highlighting is allowed');
    assert.equal(m.timeoutBand(first), 'band_duyaoy');
    h.run(() => !!m.draft.picks[first]);
    assert.equal(m.draft.picks[first], 'band_duyaoy');
    h.run(() => !!m.draft.picks[second]);
    assert.ok(!Object.values(bands).includes(m.draft.picks[second]), 'the next timeout skips them too');
    h.run(() => m.phase !== PHASE.BAND_DRAFT);
    assert.equal(m.draft.picks.ai_0, 'band_bldsk');
    assert.equal(m.draft.picks.ai_1, 'band_amiya');
    m.dispose();
  }
  // a human departing before its pick (holding nothing): the AI drafts for it at once by the team's rule (upstream
  // §37.65: Touch while nobody else has it, never 歌利亚) — never a designated strategy
  {
    const h = toBandDraft({ seats: seatsOf(['p_0', 'p_1', 'ai_0', 'ai_1'], bands), seed: 2, aiPicksLast: true });
    const m = h.m;
    const [first, second] = m.draft.order;
    assert.ok(!isAi(first) && !isAi(second));
    m.onLeave(second);
    h.sched.advance(1);
    assert.equal(m.draft.picks[second], 'band_amedic');
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_pepe' }), { ok: true });
    h.run(() => m.phase !== PHASE.BAND_DRAFT);
    assert.equal(m.draft.picks.ai_0, 'band_bldsk');
    assert.equal(m.draft.picks.ai_1, 'band_amiya');
    m.dispose();
  }
  // the draft ending with seats unpicked (finishBandDraft, seat order): the human's default skips the held strategies,
  // the designated AI seats take theirs
  {
    const h = toBandDraft({ seats: seatsOf(['p_0', 'ai_0', 'ai_1'], bands), seed: 4, aiPicksLast: true });
    const m = h.m;
    assert.equal(m.draftTurn(), 'p_0');
    m.finishBandDraft(true);
    assert.deepEqual(m.draft.picks, { p_0: 'band_duyaoy', ai_0: 'band_bldsk', ai_1: 'band_amiya' });
    m.dispose();
  }
});

test('one AI seat per strategy: a repeated designation stays with the lowest seat, the other AI picks by itself', () => {
  const h = toBandDraft({ seats: seatsOf(['p_0', 'ai_0', 'ai_1'], { ai_0: 'band_amiya', ai_1: 'band_amiya' }), seed: 6, aiPicksLast: true });
  const m = h.m;
  assert.deepEqual([...m.botBands], [['ai_0', 'band_amiya']]);
  assert.deepEqual(m.publicView().draft.reserved, { band_amiya: 'ai_0' });
  assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: 'band_bldsk' }), { ok: true });
  h.run(() => m.phase !== PHASE.BAND_DRAFT);
  assert.equal(m.draft.picks.ai_0, 'band_amiya');
  assert.ok(!['band_amiya', 'band_bldsk'].includes(m.draft.picks.ai_1));
  m.dispose();
});

test('expanded-capacity rooms (repeats allowed): nothing is held or listed, the AI seat still takes its strategy', () => {
  const h = toBandDraft({ seats: seatsOf(['p_0', 'ai_0', 'ai_1'], { ai_0: 'band_amiya' }), seed: 6, aiPicksLast: true, experimental: CAP8 });
  const m = h.m;
  assert.equal(m.capacityExperiment, true);
  const d = m.publicView().draft;
  assert.equal(d.allowRepeat, true);
  assert.equal(Object.hasOwn(d, 'reserved'), false);
  assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: 'band_amiya' }), { ok: true }, 'the human may repeat it');
  h.run(() => m.phase !== PHASE.BAND_DRAFT);
  assert.equal(m.draft.picks.ai_0, 'band_amiya');
  m.dispose();
  // 鸭爵 switched off for the room: a designation of it is not honoured (the AI picks by itself, never 鸭爵)
  const duck = toBandDraft({ seats: seatsOf(['p_0', 'ai_0'], { ai_0: 'band_ducklord' }), seed: 6, aiPicksLast: true,
    experimental: { ...CAP8, disableDuckLord: true } });
  assert.equal(duck.m.botBands.size, 0);
  assert.deepEqual(duck.m.handle('p_0', { t: 'g.band', bandId: 'band_bldsk' }), { ok: true });
  duck.run(() => duck.m.phase !== PHASE.BAND_DRAFT);
  assert.notEqual(duck.m.draft.picks.ai_0, 'band_ducklord');
  duck.m.dispose();
});

test('the whole match runs on with designated AI seats (invariants hold through round 1)', () => {
  const h = makeMatch({ mode: 'coop', fake: true, seats: seatsOf(['p_0', 'ai_0', 'ai_1'], { ai_0: 'band_bldsk', ai_1: 'band_kirara' }), seed: 9 }).start();
  h.toPrep(1, { band: 'band_amiya' });
  assert.equal(h.ps('ai_0').bandId, 'band_bldsk');
  assert.equal(h.ps('ai_1').bandId, 'band_kirara');
  assert.equal(h.ps('p_0').bandId, 'band_amiya');
  h.invariants();
  h.m.dispose();
});
