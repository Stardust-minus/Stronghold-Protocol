// A Final Assault / Hidden Core bot rehearsal on the dedicated trial Workers (server/match/combat/trial.js boss / hidden
// candidates) picks exactly what the inline rehearsal picks: the same battles tick for tick, the same leader-damage
// ranking (server/sim/rehearsal.js RehearsalScore), the same winner — and the prep driver no longer steps them on the
// match's main thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { TrialEngine, snapshotTrialInput, beatsCandidate, bestOf, NO_BEST } from '../../server/match/combat/trial.js';
import { RehearsalScore, FA_LEAK_SECONDS } from '../../server/sim/rehearsal.js';
import { createRehearsal, planLayout, trialCandidate, REHEARSAL_VARIANTS, LAYOUT_PARAMS } from '../../server/match/bot.js';
import { legalTiles, tileKey, placeClass } from '../../server/match/board.js';
import { makeMatch, give } from './harness.js';
import { DATA, QUIET, until } from './combat-fixtures.js';

const PIECES = ['4_20_b', '6_01_a', '1_06_b', '4_14_a', '4_21_a', '3_12_a'];
const clone = (x) => structuredClone(x);

/** The rehearsal's candidate plans: the default layout, the variants, and one off the routes (so ≥ 2 are distinct). */
function plansFor(m, ps, pieces) {
  const plans = [planLayout(m, ps, pieces), ...REHEARSAL_VARIANTS.slice(1).map((v) => planLayout(m, ps, pieces, { ...LAYOUT_PARAMS, ...v }))];
  const taken = new Set();
  const off = new Map();
  off.dirs = new Map();
  for (const p of pieces) {
    const tiles = [...legalTiles(ps.deployMap(), placeClass(ps, ps.gd.chess(p.id)))].map(([r, c]) => tileKey(r, c));
    const k = tiles.reverse().find((t) => !taken.has(t));
    if (!k) continue;
    taken.add(k); off.set(p.uid, k); off.dirs.set(p.uid, 'LEFT');
  }
  return [...plans, off];
}

/** Inline (RehearsalRun on Match.newBattle) vs TrialEngine on the same candidates: every battle result, ticks, winner. */
function parity(m, ps, pieces, label) {
  const plans = plansFor(m, ps, pieces);
  const built = [];
  const construct = m.newBattle.bind(m);
  m.newBattle = (opts, options) => { const b = construct(opts, options); if (String(opts.fieldId).startsWith('rb:')) built.push(b); return b; };
  const job = createRehearsal(m, ps, pieces, plans);
  m.newBattle = construct;
  assert.ok(job, `${label}: a boss rehearsal with ≥ 2 distinct layouts`);
  assert.ok(['boss', 'hidden'].includes(job.inputs[0].kind), label);
  // frozen before anything is stepped: the Worker's input is data, its pool rebuilt from boss.poolHp
  const candidates = job.inputs.map((o) => snapshotTrialInput({ playerId: ps.playerId, candidates: [trialCandidate(m, o)], cap: job.cap }).candidates[0]);
  assert.ok(candidates.every((c) => c.sharedBoss === undefined && c.boss.poolHp > 0), label);
  job.run();
  const engine = new TrialEngine({ playerId: ps.playerId, candidates, cap: job.cap }, { data: DATA });
  for (let guard = 0; !engine.advanceSlice(32); guard++) assert.ok(guard < 1e6, 'trial engine finishes');
  const state = engine.state();
  assert.equal(state.candidates.length, built.length, `${label}: same candidates`);
  for (let i = 0; i < built.length; i++) {
    const b = built[i], c = state.candidates[i];
    assert.equal(c.beaten, !b.finished, `${label}: candidate ${i} stopped early on both sides or neither`);
    if (b.finished) assert.equal(JSON.stringify(c.result), JSON.stringify(b.result()), `${label}: candidate ${i} result`);
  }
  assert.equal(state.ticks, job.stats.totalTicks, `${label}: the same ticks simulated`);
  assert.equal(state.bestIndex, job.plans.indexOf(job.best), `${label}: the same winner`);
  return { candidates: built.length, bestIndex: state.bestIndex, ticks: state.ticks, boss: state.candidates.map((c) => c.boss) };
}

function bossMatch({ mode, seed, round, bots }) {
  const seats = Array.from({ length: bots }, (_, i) => ({ seat: i, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true }));
  const h = makeMatch({ mode, difficulty: 'HARD', seats, seed, botRehearsal: 3 }).start().toPrep();
  const m = h.m;
  m.startRound(round === 'hidden' ? m.gd.hiddenRound : m.gd.bossRound);
  return m;
}

for (const [mode, bots] of [['solo', 1], ['coop', 2]]) for (const round of ['boss', 'hidden']) {
  test(`${mode} ${round} rehearsal: TrialEngine battles, ticks and winner equal the inline rehearsal (5 seeds)`, { timeout: 120_000 }, () => {
    const outcomes = [];
    for (let seed = 1; seed <= 5; seed++) {
      const m = bossMatch({ mode, seed, round, bots });
      try {
        assert.equal(m.wave, null);
        for (const ps of m.order) {
          const pieces = PIECES.map((id) => give(m, ps, `chess_char_${id}`, 'hand'));
          assert.ok(m.bossGroupOf(ps), 'the boss group is planned');
          outcomes.push(parity(m, ps, pieces, `${mode} ${round} seed ${seed} ${ps.playerId}`));
          if (mode === 'coop') {
            // the teammate fights on the board deployed now: put the rehearsed one there for the next seat
            const best = planLayout(m, ps, pieces);
            for (const [uid, key] of best) { const [row, col] = key.split(',').map(Number); ps.move(uid, { area: 'board', row, col }); }
          }
        }
      } finally { m.dispose(); }
    }
    assert.ok(outcomes.some((o) => o.bestIndex > 0) || outcomes.some((o) => o.boss.some((b) => b > 0)),
      `the corpus exercises the ranking: ${JSON.stringify(outcomes)}`);
  });
}

test('the Worker ranking is RehearsalScore\'s: leaks, then leader damage, then score — the best score may fall', () => {
  const a = { leaks: 0, boss: 7000, score: 20 }, b = { leaks: 0, boss: 5000, score: 30 }, c = { leaks: 1, boss: 9000, score: 900 };
  assert.equal(beatsCandidate(a, b), true, 'more leader damage wins a leak tie on fewer kills');
  assert.equal(beatsCandidate(b, a), false);
  assert.equal(beatsCandidate(b, c), true, 'one counted leak outranks any leader damage');
  assert.equal(beatsCandidate({ leaks: 0, boss: 0, score: 3 }, { leaks: 0, boss: 0, score: 2.99 }), true, 'a normal field: the score');
  assert.equal(beatsCandidate(a, { leaks: Infinity, boss: -Infinity, score: -Infinity }), true, 'anything beats none');
  // §37.37: the layers gained break a leak and leader-damage tie before the score
  assert.equal(beatsCandidate({ leaks: 0, boss: 0, gain: 4, score: 1 }, { leaks: 0, boss: 0, gain: 3, score: 9 }), true);
  // §37.61: a boss field ranks leader damage x (1 - leaks / FA_LEAK_SECONDS) first
  const leaky = { leaks: 3, boss: 9000, gain: 0, score: -3000 }, tight = { leaks: 0, boss: 8000, gain: 0, score: 5 };
  assert.equal(beatsCandidate(leaky, tight), false, 'a normal field: one leak outranks any leader damage');
  assert.equal(beatsCandidate(leaky, tight, true), 9000 * (1 - 3 / FA_LEAK_SECONDS) > 8000, 'a boss field: the discounted damage');
  assert.equal(beatsCandidate({ leaks: 0, boss: 100, gain: 0, score: 0 }, NO_BEST, true), true, 'no discount against none');
  assert.equal(beatsCandidate({ leaks: 1, boss: 0, gain: 0, score: 0 }, { leaks: 2, boss: 0, gain: 0, score: 0 }, true), true,
    'no leader damage on either side: the usual order');
});

test('bestOf replays RehearsalScore.note exactly on random boss and normal candidate sequences', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let trial = 0; trial < 400; trial++) {
    const kind = rand(2) ? 'boss' : 'normal';
    const n = 1 + rand(8);
    const score = new RehearsalScore('p');
    const records = [];
    for (let i = 0; i < n; i++) {
      const leaks = rand(4), boss = kind === 'boss' ? [0, 1000, 1000 + 1e-7, 2500][rand(4)] * (1 + rand(3)) : 0;
      const killed = rand(20), gain = rand(3), scored = rand(10) > 0;
      const pp = { leaked: Array.from({ length: leaks }, () => ({ counted: true })), bossDamage: boss, killed, layerGains: { a: gain } };
      score.note({ kind, result: () => (scored ? { perPlayer: { p: pp } } : { synthetic: true, perPlayer: {} }) }, i);
      records.push(scored ? { leaks, boss, gain, score: -leaks * 1000 + killed - i * 0.01 } : { leaks: null, boss: null, gain: null, score: null });
    }
    const { index, best } = bestOf(records, () => kind === 'boss');
    assert.equal(index, score.index, `trial ${trial}: ${JSON.stringify(records)}`);
    if (best !== NO_BEST) assert.deepEqual([best.leaks, best.boss, best.gain, best.score], [score.leaks, score.boss, score.gain, score.score]);
  }
});

test('a boss / hidden trial candidate carries its pool as data, never a live pool', () => {
  const m = bossMatch({ mode: 'solo', seed: 2, round: 'boss', bots: 1 });
  try {
    const ps = m.order[0];
    const pieces = PIECES.map((id) => give(m, ps, `chess_char_${id}`, 'hand'));
    const job = createRehearsal(m, ps, pieces, plansFor(m, ps, pieces));
    const opts = job.inputs[0];
    assert.ok(opts.sharedBoss, 'the inline candidate has its own pool');
    const input = (candidate) => ({ playerId: ps.playerId, candidates: [candidate], cap: job.cap });
    assert.throws(() => snapshotTrialInput(input({ ...opts })), /sharedBoss must contain only plain data/, 'a live SharedBossPool is refused');
    const { boss: _boss, ...noPool } = trialCandidate(m, opts);
    assert.throws(() => snapshotTrialInput(input(noPool)), /boss \{ poolHp, poolMax \}/);
    assert.throws(() => snapshotTrialInput(input({ ...noPool, boss: { poolHp: 0, poolMax: 1 } })), /boss \{ poolHp, poolMax \}/);
    assert.equal(snapshotTrialInput(input(trialCandidate(m, opts))).candidates[0].kind, opts.kind);
  } finally { m.dispose(); }
});

// The actual prep driver (real scheduler) of an AI-托管 seat in a Final Assault prep, with and without the trial pool.
function driverFixture(t, { trialPool = null, seed, round, bot = false }) {
  const errors = [], warnings = [];
  const m = new Match({ roomCode: 'BOSSR', mode: 'coop', difficulty: 'HARD', seed, data: DATA,
    seats: [0, 1].map((seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: bot && seat === 0, connected: true })),
    send: () => true, broadcast() {}, onEnd() {},
    log: { ...QUIET, warn: (s) => warnings.push(s), error: (s) => errors.push(s) },
    clientCombat: false, verify: 'off', trialPool, timerScale: 0.001, botSliceMs: 2, botRehearsal: 3 });
  t.after(() => m.dispose());
  m.phase = 'PREP';
  m.round = round === 'hidden' ? m.gd.hiddenRound : m.gd.bossRound;
  m._planBossWaves();
  const ps = m.order[0];
  for (const p of m.order) { p.lp = 40; p.bandId = 'band_bldsk'; p.recompute(); }
  if (!bot) ps.autoplay = true;
  ps.funds = 12; ps.shop.level = 5; ps.shop.upgradePrice = m.gd.upgradeBase(5);
  ps.rollShop();
  for (const id of PIECES) give(m, ps, `chess_char_${id}`);
  const h = { m, ps, errors, warnings, completed: null, mainTicks: 0, inputs: [] };
  const construct = m.newBattle.bind(m);
  m.newBattle = (opts, options) => {
    const b = construct(opts, options);
    if (String(opts.fieldId).startsWith('rb:')) { const step = b.step.bind(b); b.step = () => { h.mainTicks++; step(); }; }
    return b;
  };
  const cancel = m._cancelBotPrep.bind(m);
  m._cancelBotPrep = (p) => {
    const job = p._botPrepWork?.job;
    if (job?.done) h.completed = { remote: job.remote === true, inline: job.inline === true, ticks: job.progress?.ticks ?? job.stats?.totalTicks,
      plans: job.plans.map((plan) => [...plan]), best: [...job.best] };
    cancel(p);
  };
  return h;
}
const snapshot = (m) => clone({ rng: ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta'].map((k) => m[k].state()),
  players: m.order.map((p) => ({ board: [...p.board], hand: p.hand, funds: p.funds, shop: p.shop, ready: p.ready, bonds: p.bonds })) });

async function driverRun(t, pool, { seed, round, bot = false }) {
  const trace = { inputs: [], runTrial(input, callbacks) { trace.inputs.push(clone(input)); return pool.runTrial(input, callbacks); } };
  const inline = driverFixture(t, { seed, round, bot });
  inline.m.scheduleBotPrep(inline.ps);
  await until(() => inline.ps.ready, 30_000);
  const remote = driverFixture(t, { seed, round, trialPool: trace, bot });
  remote.m.scheduleBotPrep(remote.ps);
  await until(() => remote.ps.ready, 30_000);
  for (const h of [inline, remote]) assert.deepEqual(h.errors, []);
  assert.equal(remote.mainTicks, 0, 'no rehearsal battle stepped on the match thread');
  assert.deepEqual(snapshot(remote.m), snapshot(inline.m), 'same layout, economy and random streams');
  assert.deepEqual(remote.warnings, []);
  if (!inline.completed) {
    // this prep had fewer than two distinct layouts: nothing to rehearse on either side
    assert.equal(inline.mainTicks, 0); assert.equal(remote.completed, null); assert.equal(trace.inputs.length, 0);
    return false;
  }
  assert.ok(inline.mainTicks > 0, 'the inline rehearsal stepped boss battles on main');
  assert.equal(inline.completed.remote, false);
  assert.equal(remote.completed.remote, true, 'the boss rehearsal went to the trial pool');
  assert.equal(remote.completed.inline, false);
  assert.equal(trace.inputs.length, 1);
  assert.ok(trace.inputs[0].candidates.every((c) => c.kind === (round === 'hidden' ? 'hidden' : 'boss') && c.boss.poolHp > 0));
  assert.deepEqual(remote.completed.plans, inline.completed.plans);
  assert.deepEqual(remote.completed.best, inline.completed.best);
  assert.equal(remote.completed.ticks, inline.mainTicks, 'the same ticks simulated');
  // §37.67: a bot's own Final Assault seat asks the Worker for its operators' leader damage; both sides keep the same
  // counts for the item hunt (an AI 托管 seat hunts nothing and asks for none)
  const hunts = bot && round === 'boss';
  assert.equal(trace.inputs[0].lead, hunts ? true : undefined);
  const lead = (h) => (h.ps._botFaLead && h.ps._botFaLead.round === h.m.round && h.ps._botFaLead.lead ? [...h.ps._botFaLead.lead] : null);
  assert.deepEqual(lead(remote), lead(inline), 'the same leader damage per operator');
  if (hunts) assert.ok(lead(inline), 'the inline rehearsal counted');
  return true;
}

for (const round of ['boss', 'hidden']) {
  test(`actual prep driver, ${round} round: the trial Worker's layout equals inline and main steps no rehearsal battle`, { timeout: 120_000 }, async (t) => {
    const pool = new CombatWorkerPool({ role: 'trial', size: 1, data: DATA, log: QUIET });
    t.after(() => pool.close());
    await pool.start();
    let rehearsed = 0;
    for (const seed of [3, 5, 8, 11]) if (await driverRun(t, pool, { seed, round })) rehearsed++;
    assert.ok(rehearsed >= 2, `at least two of the seeds rehearse (${rehearsed})`);
  });
}

test('actual prep driver, a bot\'s own Final Assault seat: the Worker returns the winner\'s leader damage per operator (§37.67) and the hunt equips the same', { timeout: 180_000 }, async (t) => {
  const pool = new CombatWorkerPool({ role: 'trial', size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  let rehearsed = 0;
  for (const seed of [3, 5, 8, 11]) if (await driverRun(t, pool, { seed, round: 'boss', bot: true })) rehearsed++;
  assert.ok(rehearsed >= 2, `at least two of the seeds rehearse (${rehearsed})`);
});
