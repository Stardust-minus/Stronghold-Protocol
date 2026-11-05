// Bond plan (盟约预选, a remake feature, display only): g.bondPlan { bondId?, subIds? } — a human player announces the
// 主盟约 (a core bond) and up to BOND_PLAN_SUB_MAX 副盟约 (any bond with a visible member, not the main one) it means to
// build, from INFO_CHECK until the match ends while it is alive (rel34, the owner's 「允许预选副盟约」「盟约预选支持多选」
// 「预选的盟约在局内可以二次更改」); every teammate and spectator sees it as m.public players[].bondPlan / bondPlanSub for the
// whole match (reconnects and new spectator seats included), and a change after the strategy draft is told to everyone
// (m.notice bondPlan, at most once per BOND_PLAN_COOLDOWN_MS). Plannable: the mode's switched-off bonds and the drawn set
// included; anything else is BAD_TARGET. An older page's message (no subIds) changes the main bond only. Checkpoints
// carry the secondary bonds; one written before rel34 restores none. Nothing else of the match reads the plan
// (server/match/match/intents.js planBond).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE, BOND_PLAN_SUB_MAX, BOND_PLAN_COOLDOWN_MS } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { GameData } from '../../server/match/gamedata.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { DATA, makeMatch } from './harness.js';

const CORE = ['yanShip', 'sargonShip', 'victoriaShip', 'kjeragShip', 'lateranoShip', 'egirShip', 'siracusaShip', 'kazimierzShip'];
const S = 's_spec';
const plan = (m, pid, bondId, subIds) => m.handle(pid, {
  t: 'g.bondPlan', ...(bondId === undefined ? {} : { bondId }), ...(subIds === undefined ? {} : { subIds }),
});
/** players[].bondPlan of an m.public frame by playerId */
const plans = (pub) => Object.fromEntries(pub.players.map((p) => [p.playerId, p.bondPlan]));
/** players[].bondPlanSub of an m.public frame by playerId ([] when omitted) */
const subs = (pub) => Object.fromEntries(pub.players.map((p) => [p.playerId, p.bondPlanSub ?? []]));
const notices = (h) => h.bc.filter((x) => x.t === 'm.notice' && x.kind === 'bondPlan');

test('protocol: g.bondPlan { bondId?, subIds? } validates (absent / null main clears, absent subIds keeps)', () => {
  assert.equal(BOND_PLAN_SUB_MAX, 4);
  assert.equal(validateC2S({ t: 'g.bondPlan', bondId: 'yanShip' }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan', bondId: null }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan' }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan', bondId: 'yanShip', subIds: [] }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan', bondId: null, subIds: ['preciShip', 'swiftShip', 'egirShip'] }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan', subIds: ['preciShip'] }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan', bondId: 'yanShip', subIds: ['preciShip', 'swiftShip', 'egirShip', 'sargonShip'] }), null, 'four 副盟约 (the owner: 「副盟约最多选择4个」)');
  for (const bondId of ['', 'a b', 12, true, {}, 'a'.repeat(65)]) assert.notEqual(validateC2S({ t: 'g.bondPlan', bondId }), null, String(bondId));
  for (const subIds of [null, 'preciShip', {}, [''], [7], ['a b'], ['preciShip', 'swiftShip', 'egirShip', 'yanShip', 'sargonShip']]) {
    assert.notEqual(validateC2S({ t: 'g.bondPlan', bondId: 'yanShip', subIds }), null, JSON.stringify(subIds));
  }
});

test('plannable bonds: the main one among the eight core bonds, the secondary ones among every bond with a member (all but 绝技), in every mode', () => {
  const withMembers = Object.values(DATA.bonds).filter((b) => b.visibleMembers.length > 0).map((b) => b.bondId);
  for (const modeId of Object.keys(DATA.config.modes)) {
    const gd = new GameData(DATA, modeId);
    assert.deepEqual([...gd.plannableBondIds()], CORE, modeId);
    assert.ok(Object.isFrozen(gd.plannableBondIds()));
    assert.deepEqual([...gd.subPlannableBondIds()], gd.bondIds.filter((id) => withMembers.includes(id)), modeId);
    assert.ok(Object.isFrozen(gd.subPlannableBondIds()));
  }
  const funny = new GameData(DATA, 'mode_multi_funny');
  assert.equal(funny.subPlannableBondIds().length, 22);
  assert.ok(CORE.every((id) => funny.bondSubPlannable(id)), 'a core bond may be a secondary one');
  for (const id of ['lateranoShip', 'egirShip', 'kazimierzShip']) {
    assert.ok(funny.modeInactiveBonds.has(id), `${id} is off in 标准模拟`);
    assert.equal(funny.bondPlannable(id), true, `${id} is still plannable`);
  }
  for (const id of ['preciShip', 'swiftShip', 'maniShip', 'emptyShip', 'soloShip', 'investShip', 'arcaneShip']) {
    assert.equal(funny.bondPlannable(id), false, `${id} is no main bond`);
    assert.equal(funny.bondSubPlannable(id), true, `${id} may be a secondary one`);
  }
  for (const id of ['suntShip', 'nope', '__proto__', 'constructor', '', null, 7]) {
    assert.equal(funny.bondPlannable(id), false, String(id));
    assert.equal(funny.bondSubPlannable(id), false, String(id));
  }
  // the data says the same: the core bonds are exactly the SEASON bonds
  assert.deepEqual(Object.values(DATA.bonds).filter((b) => b.isCore).map((b) => b.bondId).sort(), [...CORE].sort());
  assert.ok(Object.values(DATA.bonds).every((b) => (b.bondType === 'SEASON') === (b.isCore === true)));
});

test('accepted from INFO_CHECK to the end of the match (combat included), told to everyone once the draft is over; kept the whole match', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 4711, fake: true, script: () => ({ duration: 2 }) }).start();
  const m = h.m;
  assert.equal(m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(plans(m.publicView()), { p_0: null, p_1: null, ai_0: null }, 'nobody planned yet');
  assert.ok(m.publicView().players.every((p) => !('bondPlanSub' in p)), 'no secondary bonds: the key is omitted');
  const step = (phase, round, bondId, subIds, notify) => {
    assert.ok(h.drive(() => m.phase === phase && m.round === round, { ready: false }), `reach ${phase} R${round}`);
    h.ps('p_0')._planAt = -Infinity; // the cooldown is its own test
    const before = notices(h).length;
    assert.deepEqual(plan(m, 'p_0', bondId, subIds), { ok: true }, `${phase} R${round}`);
    assert.equal(h.ps('p_0').bondPlan, bondId);
    assert.deepEqual(h.ps('p_0').bondPlanSub, subIds);
    assert.equal(notices(h).length - before, notify ? 1 : 0, `${phase} R${round}: ${notify ? 'one notice' : 'no notice in the opening'}`);
  };
  step(PHASE.INFO_CHECK, 0, 'yanShip', ['preciShip'], false);
  step(PHASE.BAND_DRAFT, 0, 'sargonShip', ['preciShip', 'swiftShip'], false);
  step(PHASE.BATTLE_CHECK, 0, 'victoriaShip', [], true);
  step(PHASE.ROUND_START, 1, 'kjeragShip', ['egirShip'], true);
  step(PHASE.PREP, 1, 'lateranoShip', ['egirShip', 'arcaneShip', 'yanShip'], true);
  const last = notices(h).at(-1);
  assert.deepEqual(last, { t: 'm.notice', kind: 'bondPlan', playerId: 'p_0', name: h.ps('p_0').name, bondId: 'lateranoShip', subIds: ['egirShip', 'arcaneShip', 'yanShip'] });
  // two players may plan the same bonds
  assert.deepEqual(plan(m, 'p_1', 'lateranoShip', ['egirShip']), { ok: true });
  h.flushAll();
  assert.deepEqual(plans(h.lastBc('m.public')), { p_0: 'lateranoShip', p_1: 'lateranoShip', ai_0: null });
  assert.deepEqual(subs(h.lastBc('m.public')), { p_0: ['egirShip', 'arcaneShip', 'yanShip'], p_1: ['egirShip'], ai_0: [] });

  // the battle and every later phase: still changeable (the owner's 「局内可以二次更改」)
  step(PHASE.COMBAT, 1, null, ['soloShip'], true);
  step(PHASE.SETTLE, 1, 'yanShip', ['soloShip'], true);
  step(PHASE.PREP, 2, 'egirShip', ['preciShip'], true);
  h.flushAll();
  assert.deepEqual(plans(h.lastBc('m.public')), { p_0: 'egirShip', p_1: 'lateranoShip', ai_0: null });
  // an eliminated player's plan stays shown, unchangeable
  h.ps('p_1').alive = false;
  assert.deepEqual(plan(m, 'p_1', 'yanShip', []), { error: ERR.ELIMINATED });
  assert.equal(h.ps('p_1').bondPlan, 'lateranoShip');
  h.ps('p_1').alive = true;
  h.invariants();
  m.dispose();
});

test('the window by phase: every phase but LOBBY and RESULT; an ended match refuses', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 1, seed: 5, fake: true }).start();
  const m = h.m;
  for (const phase of Object.values(PHASE)) {
    for (const round of [0, 1, 2, 3]) {
      m.phase = phase;
      m.round = round;
      const want = phase !== PHASE.LOBBY && phase !== PHASE.RESULT;
      assert.equal(m.bondPlanOpen(), want, `${phase} R${round}`);
      h.ps('p_0')._planAt = -Infinity;
      const res = m._handle(h.ps('p_0'), { t: 'g.bondPlan', bondId: round % 2 ? 'egirShip' : 'siracusaShip' });
      assert.deepEqual(res, want ? { ok: true } : { error: ERR.WRONG_PHASE }, `${phase} R${round}`);
    }
  }
  m.phase = PHASE.PREP;
  m.ended = true;
  assert.equal(m.bondPlanOpen(), false);
  m.ended = false;
  m.dispose();
});

test('invalid ids are BAD_TARGET and change nothing; null / absent main clears; absent subIds keeps the secondary bonds (an older page); the same plan again changes nothing', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 2, seed: 77, fake: true }).start();
  const m = h.m;
  for (const bondId of ['preciShip', 'suntShip', 'maniShip', 'band_bldsk', 'chess_char_1_08_a', 'nope', '__proto__', 'constructor', 'toString', 42, {}]) {
    // handle() may be reached without validateC2S (defence in depth): a non-string id is refused too
    assert.deepEqual(m.handle('p_0', { t: 'g.bondPlan', bondId }), { error: ERR.BAD_TARGET }, String(bondId));
  }
  assert.equal(h.ps('p_0').bondPlan, null);
  // 标准模拟 switches 阿戈尔 (and 奥术) off — still plannable
  assert.deepEqual(plan(m, 'p_0', 'egirShip', ['arcaneShip', 'preciShip']), { ok: true });
  const keep = () => { assert.equal(h.ps('p_0').bondPlan, 'egirShip'); assert.deepEqual(h.ps('p_0').bondPlanSub, ['arcaneShip', 'preciShip']); };
  keep();
  assert.deepEqual(plan(m, 'p_0', 'nope'), { error: ERR.BAD_TARGET });
  keep();
  for (const subIds of [['suntShip'], ['nope'], ['preciShip', 'preciShip'], ['egirShip'], ['preciShip', 'swiftShip', 'steadShip', 'visiShip', 'raidShip'], ['__proto__'], [7], 'preciShip', null]) {
    assert.deepEqual(plan(m, 'p_0', 'egirShip', subIds), { error: ERR.BAD_TARGET }, JSON.stringify(subIds));
    keep();
  }
  // four 副盟约 is the limit (BOND_PLAN_SUB_MAX 4)
  assert.deepEqual(plan(m, 'p_0', 'egirShip', ['preciShip', 'swiftShip', 'steadShip', 'visiShip']), { ok: true });
  assert.deepEqual(h.ps('p_0').bondPlanSub, ['preciShip', 'swiftShip', 'steadShip', 'visiShip']);
  assert.deepEqual(plan(m, 'p_0', 'egirShip', ['arcaneShip', 'preciShip']), { ok: true });
  keep();
  assert.deepEqual(plan(m, 'p_0', 'yanShip', ['egirShip', 'egirShip']), { error: ERR.BAD_TARGET }, 'a refused secondary list keeps the main too');
  keep();

  let marks = 0;
  const mark = m.markPublic.bind(m);
  m.markPublic = () => { marks++; mark(); };
  assert.deepEqual(plan(m, 'p_0', 'egirShip', ['arcaneShip', 'preciShip']), { ok: true }, 'the same plan again');
  assert.deepEqual(plan(m, 'p_0', 'egirShip'), { ok: true }, 'the same main, the secondary bonds kept');
  assert.equal(marks, 0, 'an unchanged plan marks nothing');
  // an older page's message: the main changes, the secondary bonds stay — minus the new main
  assert.deepEqual(plan(m, 'p_0', 'yanShip'), { ok: true });
  assert.deepEqual(h.ps('p_0').bondPlanSub, ['arcaneShip', 'preciShip']);
  assert.equal(marks, 1, 'a change marks m.public once');
  assert.deepEqual(plan(m, 'p_0', 'kjeragShip', ['kazimierzShip', 'yanShip']), { ok: true }, 'a core bond as a secondary one');
  assert.deepEqual(plan(m, 'p_0', 'yanShip'), { ok: true });
  assert.deepEqual(h.ps('p_0').bondPlanSub, ['kazimierzShip'], 'the new main leaves the secondary bonds');
  assert.deepEqual(plan(m, 'p_0', null), { ok: true });
  assert.equal(h.ps('p_0').bondPlan, null, 'null clears the main');
  assert.deepEqual(h.ps('p_0').bondPlanSub, ['kazimierzShip']);
  assert.deepEqual(plan(m, 'p_0', undefined, []), { ok: true });
  assert.equal(h.ps('p_0').bondPlan, null, 'absent clears the main');
  assert.deepEqual(h.ps('p_0').bondPlanSub, [], 'subIds [] clears the secondary bonds');
  assert.deepEqual(plan(m, 'p_0', null, ['preciShip', 'swiftShip', 'steadShip']), { ok: true }, 'secondary bonds without a main one');
  assert.deepEqual(plan(m, 'p_0'), { ok: true }, 'clearing nothing is fine');
  assert.equal(marks, 6, 'one mark per change');
  assert.equal(notices(h).length, 0, 'the briefing tells nobody');
  m.dispose();
});

test('after the draft: one m.notice per change to every player and spectator, at most one per BOND_PLAN_COOLDOWN_MS (RATE)', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 33, fake: true, spectators: [S] }).start();
  const m = h.m;
  assert.ok(h.drive(() => m.phase === PHASE.PREP && m.round === 1, { ready: false }), 'reach PREP R1');
  assert.deepEqual(plan(m, 'p_0', 'yanShip', ['preciShip']), { ok: true });
  assert.equal(notices(h).length, 1);
  assert.deepEqual(plan(m, 'p_0', 'yanShip', ['preciShip']), { ok: true }, 'the same plan again: no notice, no cooldown');
  assert.equal(notices(h).length, 1);
  assert.deepEqual(plan(m, 'p_0', 'sargonShip', []), { error: ERR.RATE });
  assert.equal(h.ps('p_0').bondPlan, 'yanShip', 'refused: unchanged');
  assert.deepEqual(plan(m, 'p_1', 'sargonShip', []), { ok: true }, 'the cooldown is the player\'s own');
  assert.equal(notices(h).length, 2);
  h.sched.advance(BOND_PLAN_COOLDOWN_MS);
  assert.equal(m.phase, PHASE.PREP);
  assert.deepEqual(plan(m, 'p_0', null, []), { ok: true });
  assert.deepEqual(notices(h).at(-1), { t: 'm.notice', kind: 'bondPlan', playerId: 'p_0', name: h.ps('p_0').name, bondId: null, subIds: [] }, 'a cleared plan');
  assert.equal(notices(h).length, 3);
  // one broadcast: every seated human and every spectator seat gets the same frame (opts.broadcast); the spectator cannot plan
  assert.deepEqual(plan(m, S, 'yanShip'), { error: ERR.SPECTATOR });
  m.dispose();
});

test('spectator seats and AI seats cannot plan; a departed player neither', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 31, fake: true, spectators: [S] }).start();
  const m = h.m;
  assert.deepEqual(plan(m, S, 'yanShip'), { error: ERR.SPECTATOR });
  assert.deepEqual(plan(m, 'ai_0', 'yanShip'), { error: ERR.NOT_IN_ROOM });
  assert.deepEqual(plan(m, 'p_0', 'yanShip', ['soloShip']), { ok: true });
  m.onLeave('p_0');
  assert.deepEqual(plan(m, 'p_0', 'sargonShip'), { error: ERR.NOT_IN_ROOM });
  assert.deepEqual(plans(m.publicView()), { p_0: 'yanShip', p_1: null, ai_0: null }, 'the departed player\'s plan stays shown');
  assert.deepEqual(subs(m.publicView()), { p_0: ['soloShip'], p_1: [], ai_0: [] });
  m.dispose();
});

test('visible to every teammate and spectator, survives a reconnect resync and reaches a spectator seat taken later', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 3, seed: 902, fake: true, clientCombat: true, spectators: [S],
    script: () => ({ duration: 1 }) }).start();
  const m = h.m;
  assert.deepEqual(plan(m, 'p_0', 'yanShip', ['preciShip', 'swiftShip']), { ok: true });
  assert.deepEqual(plan(m, 'p_2', 'kazimierzShip'), { ok: true });
  h.flushAll();
  const want = { p_0: 'yanShip', p_1: null, p_2: 'kazimierzShip' };
  const wantSub = { p_0: ['preciShip', 'swiftShip'], p_1: [], p_2: [] };
  // m.public is one broadcast: every seated human and every spectator seat gets the same frame (opts.broadcast)
  assert.deepEqual(plans(h.lastBc('m.public')), want);
  assert.deepEqual(subs(h.lastBc('m.public')), wantSub);
  assert.ok(!h.allTo('p_0', 'm.private').some((p) => 'bondPlan' in p || 'bondPlanSub' in p), 'never in m.private');
  // the plans survive the opening and every later phase
  h.autoHumans();
  h.toPrep(2);
  h.flushAll();
  assert.deepEqual(plans(h.lastBc('m.public')), want, 'round 2 prep');
  assert.deepEqual(subs(h.lastBc('m.public')), wantSub, 'round 2 prep');
  // a reconnect (or a resync request) resends m.public with the plans
  m.onDisconnect('p_1');
  m.onReconnect('p_1');
  assert.deepEqual(plans(h.lastTo('p_1', 'm.public')), want, 'reconnect resync');
  assert.deepEqual(subs(h.lastTo('p_1', 'm.public')), wantSub, 'reconnect resync');
  // the spectator's own resync and a spectator seat taken mid-match
  m.addSpectator(S);
  assert.deepEqual(plans(h.lastTo(S, 'm.public')), want, 'spectator resync');
  m.addSpectator('s_late');
  assert.deepEqual(subs(h.lastTo('s_late', 'm.public')), wantSub, 'a spectator seat taken later');
  const end = h.runToEnd();
  assert.ok(end);
  assert.deepEqual(plans(h.lastBc('m.public')), want, 'the final m.public');
  assert.equal(JSON.stringify(end).includes('bondPlan'), false, 'the summary (golden digests, receipts) carries no plan');
});

test('checkpoints carry the secondary bonds; one without them (written before rel34) restores none; a key this server does not know is ignored', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 6060, fake: true }).start();
  assert.equal(h.m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(plan(h.m, 'p_0', 'yanShip', ['preciShip', 'egirShip']), { ok: true });
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  const restore = (d) => {
    const r = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: d.seats, seed: d.seed, fake: true });
    assert.equal(restoreMatch(r.m, JSON.parse(JSON.stringify(d)), { createRngFromState }), true);
    return r;
  };
  const same = restore(doc);
  assert.equal(same.ps('p_0').bondPlan, 'yanShip');
  assert.deepEqual(same.ps('p_0').bondPlanSub, ['preciShip', 'egirShip']);
  assert.equal(same.ps('p_0')._planAt, -Infinity, 'the notice cooldown is not saved');
  same.m.dispose();
  // rel33's checkpoint: no bondPlanSub key
  const old = JSON.parse(JSON.stringify(doc));
  for (const p of old.players) delete p.f.bondPlanSub;
  const r33 = restore(old);
  assert.equal(r33.ps('p_0').bondPlan, 'yanShip', 'the main bond is as before');
  assert.deepEqual(r33.ps('p_0').bondPlanSub, []);
  assert.ok(r33.m.publicView().players.every((p) => !('bondPlanSub' in p)));
  r33.m.dispose();
  // a later version's key (a rollback reads a newer checkpoint the same way rel33 reads this one)
  const later = JSON.parse(JSON.stringify(doc));
  for (const p of later.players) p.f.someLaterField = 1;
  const r = restore(later);
  assert.equal(Object.hasOwn(r.ps('p_0'), 'someLaterField'), false);
  r.m.dispose();
  h.m.dispose();
});

test('nobody planning: every player reads bondPlan null and no bondPlanSub from the first m.public to the end', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', seed: 3, fake: true, script: () => ({ duration: 1 }) });
  h.autoHumans().start();
  h.runToEnd();
  const frames = h.bc.filter((x) => x.t === 'm.public');
  assert.ok(frames.length > 5);
  for (const f of frames) for (const p of f.players) { assert.equal(p.bondPlan, null); assert.equal('bondPlanSub' in p, false); }
  assert.equal(notices(h).length, 0);
});
