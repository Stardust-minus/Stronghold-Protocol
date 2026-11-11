// Match checkpoints (server/match/snapshot.js, docs/DEPLOY.md「断点续玩」): every field classified, a checkpoint restores
// losslessly into a fresh Match from every safe phase, and the restored match plays on — identically while nothing
// time-dependent intervenes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { OFFLINE_TAKEOVER_ROUNDS } from '../../server/match/Match.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { canSnapshot, snapshotMatch, restoreMatch, matchState, encodeValue, decodeValue, MATCH_FIELDS, PLAYER_FIELDS,
  SNAPSHOT_VERSION, RESTORE_SEQ_GAP, MIN_RECOVER_PREP_SEC, CHECKPOINT_PREP_END } from '../../server/match/snapshot.js';

const classified = (lists) => new Set(Object.values(lists).flat());
const twenty = { revivalEnabled: true, disableSharedPool: false, playerCapacity: 20 };

/** A fresh match built from a checkpoint (the platform's restore path), the checkpoint applied. */
function restored(doc, o = {}) {
  const json = JSON.parse(JSON.stringify(doc));
  // nobody rejoins these restored matches and they must play on like the original: the offline hold off
  // (a restored match nobody comes back to holds: test/match/offline-hold.test.js)
  const r = makeMatch({ mode: o.mode ?? 'coop', difficulty: o.difficulty ?? 'NORMAL', seats: json.seats, seed: json.seed,
    matchNo: o.matchNo, experimental: o.experimental, offlineHoldMs: 0 });
  assert.equal(restoreMatch(r.m, json, { createRngFromState, log: { warn: (...a) => r.logs.warn.push(a.join(' ')) }, replay: o.replay }), true);
  return r;
}

test('codec: Maps, Sets, ±Infinity, undefined and non-enumerable properties round-trip; functions and class instances are refused', () => {
  const arr = [1, 2];
  Object.defineProperty(arr, 'schedule', { value: [{ r: 1 }], enumerable: false });
  const obj = { a: 1 };
  Object.defineProperty(obj, 'hidden', { value: 'h', enumerable: false });
  const v = { m: new Map([['k', new Set([1, -Infinity])]]), inf: Infinity, nan: NaN, u: undefined, arr, obj, nested: [{ x: null }] };
  const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(v))));
  assert.deepEqual([...back.m.get('k')], [1, -Infinity]);
  assert.equal(back.inf, Infinity);
  assert.ok(Number.isNaN(back.nan));
  assert.ok(Object.hasOwn(back, 'u') && back.u === undefined);
  assert.deepEqual([...back.arr], [1, 2]);
  assert.deepEqual(back.arr.schedule, [{ r: 1 }]);
  assert.equal(Object.keys(back.arr).includes('schedule'), false, 'the schedule stays non-enumerable');
  assert.equal(back.obj.hidden, 'h');
  assert.deepEqual(Object.keys(back.obj), ['a']);
  assert.throws(() => encodeValue({ f() {} }));
  assert.throws(() => encodeValue({ d: new Date() }));
});

test('every own property of a Match and a PlayerState is classified, and every safe moment can be checkpointed (4 seats, 20 seats, solo)', { timeout: 300_000 }, () => {
  const mKnown = classified(MATCH_FIELDS), pKnown = classified(PLAYER_FIELDS);
  for (const list of [MATCH_FIELDS, PLAYER_FIELDS]) {
    const all = Object.values(list).flat();
    assert.equal(new Set(all).size, all.length, 'a field is classified once');
  }
  const configs = [
    { humans: 2, bots: 2, seed: 11 },
    { humans: 3, bots: 17, seed: 12, experimental: twenty },
    { mode: 'solo', humans: 1, seed: 13 },
  ];
  for (const cfg of configs) {
    const h = makeMatch(cfg).autoHumans();
    h.start();
    const unknown = new Set();
    let checked = 0, phase = null, steps = 0;
    h.run(() => {
      for (const k of Object.keys(h.m)) if (!mKnown.has(k)) unknown.add(`Match.${k}`);
      for (const ps of h.m.order) for (const k of Object.keys(ps)) if (!pKnown.has(k)) unknown.add(`PlayerState.${k}`);
      if ((h.m.phase !== phase || ++steps % 400 === 0) && canSnapshot(h.m)) {
        phase = h.m.phase;
        assert.ok(snapshotMatch(h.m), `a checkpoint in ${h.m.phase} R${h.m.round} (${cfg.experimental ? 20 : cfg.mode ?? 'coop'})`);
        checked++;
      }
      return h.ended != null;
    });
    assert.ok(h.ended, 'the match ran to its end');
    assert.deepEqual([...unknown], [], 'unclassified fields: add them to MATCH_FIELDS / PLAYER_FIELDS (snapshot.js)');
    assert.ok(checked > 10, `checkpoints taken: ${checked}`);
  }
});

test('a checkpoint restores losslessly from every safe phase and the restored match plays on identically to the next prep end', { timeout: 300_000 }, () => {
  const cfg = { humans: 2, bots: 2, seed: 21 };
  const phases = [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.ROUND_START, PHASE.PREP];
  let tried = 0;
  for (const want of phases) {
    for (const after of want === PHASE.INFO_CHECK || want === PHASE.BAND_DRAFT ? [0] : [1, 5]) {
      const h = makeMatch(cfg).autoHumans();
      h.start();
      // the first time the phase can be checkpointed from round `after` on
      h.run(() => h.ended != null || (h.m.phase === want && h.m.round >= after && canSnapshot(h.m)));
      assert.ok(!h.ended && h.m.phase === want, `${want} from R${after} reached`);
      const round = h.m.round;
      tried++;
      const doc = snapshotMatch(h.m);
      assert.equal(doc.v, SNAPSHOT_VERSION);
      const r = restored(doc, cfg);
      assert.deepEqual(matchState(r.m), matchState(h.m), `lossless in ${want} R${round}`);
      assert.equal(r.m._battleSeq, h.m._battleSeq + RESTORE_SEQ_GAP);
      for (const ps of r.m.order) assert.equal(ps.connected, ps.isBot, 'every human seat waits for its player');
      for (const ps of r.m.order) if (!ps.isBot) r.m.onReconnect(ps.playerId); // the players come back
      // both run on to the prep end that follows: identical state there (the checkpoint the round's battle returns to)
      const until = (x, after) => x.run(() => x.ended != null || (x.m.phase === PHASE.COMBAT && x.m.round > after) || x.m.phase === PHASE.FINAL_ASSAULT);
      until(h, h.m.round - (want === PHASE.PREP ? 1 : 0)); until(r, r.m.round - (want === PHASE.PREP ? 1 : 0));
      const strip = (s) => { const { match, ...rest } = s; const { errors, errorCount, lastResults, simErrorLog, ...m } = match; return { ...rest, match: m }; };
      assert.deepEqual(strip(matchState(r.m)), strip(matchState(h.m)), `the same next prep end after ${want} R${round}`);
      assert.deepEqual(r.logs.error, []);
      r.runToEnd();
    }
  }
  assert.equal(tried, 8);
});

test('a restored prep gives the humans their board back: not Ready, at least the recovery time, offline until they return', () => {
  const h = makeMatch({ humans: 2, bots: 2, seed: 31 });
  h.start();
  const human = (m) => m.players.get('p_0');
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 3 && canSnapshot(h.m));
  human(h.m).setReady(true);
  const doc = snapshotMatch(h.m);
  const r = restored(doc, {});
  assert.equal(r.m.phase, PHASE.PREP);
  assert.equal(human(r.m).ready, false);
  assert.equal(human(r.m).connected, false);
  assert.ok(r.m.deadline - r.m.sched.now() >= MIN_RECOVER_PREP_SEC * 1000 - 1);
  // the player comes back: a full resync of its own state
  r.m.onReconnect('p_0');
  r.m.flush(true);
  assert.ok(r.lastTo('p_0', 'm.private'));
  assert.equal(human(r.m).connected, true);
});

test('a twenty-seat concurrent draft restored mid-way starts its one countdown over and keeps every pick already made', () => {
  const cfg = { humans: 4, bots: 16, seed: 41, experimental: twenty };
  const h = makeMatch(cfg);
  h.start();
  h.drive(() => h.m.phase === PHASE.BAND_DRAFT && h.m.draft?.concurrent && Object.keys(h.m.draft.picks).length >= 10, { band: 'band_bldsk' });
  // humans have not picked yet in this drive step: make one pick, leave the others deciding
  const d = h.m.draft;
  const humanId = d.order.find((id) => id.startsWith('p_') && !d.picks[id]);
  if (humanId) h.m.handle(humanId, { t: 'g.band', bandId: 'band_bldsk' });
  assert.ok(canSnapshot(h.m));
  const doc = snapshotMatch(h.m);
  const r = restored(doc, cfg);
  assert.deepEqual(r.m.draft.picks, h.m.draft.picks);
  assert.equal(r.m.draft.concurrent, true);
  assert.ok(r.m.deadline > r.m.sched.now(), 'the countdown runs again');
  r.run(() => r.m.phase !== PHASE.BAND_DRAFT || r.ended != null);
  assert.notEqual(r.m.phase, PHASE.BAND_DRAFT, 'the countdown resolves whoever is still deciding');
});

test('a checkpoint after a setup reroll restores the rerolled pools and bans', () => {
  const h = makeMatch({ humans: 2, bots: 0, seed: 51 });
  h.start();
  assert.equal(h.m.phase, PHASE.INFO_CHECK);
  assert.equal(h.m.completeSetupReroll().ok, true);
  assert.equal(h.m.setupRevision, 1);
  const doc = snapshotMatch(h.m);
  const r = restored(doc, {});
  assert.deepEqual(r.m.bannedChess, h.m.bannedChess);
  assert.equal(r.m.stageId, h.m.stageId);
  assert.deepEqual([...r.m.pool.entries.keys()], [...h.m.pool.entries.keys()]);
});

test('a checkpoint is refused for another seed, roster or version, and none is taken during a battle', () => {
  const h = makeMatch({ humans: 1, bots: 3, seed: 61 }).autoHumans();
  h.start();
  h.runToPhase(PHASE.PREP, 1);
  h.run(() => canSnapshot(h.m));
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  const other = makeMatch({ seats: doc.seats, seed: 62 });
  assert.equal(restoreMatch(other.m, doc, { createRngFromState }), false);
  const fewer = makeMatch({ seats: doc.seats.slice(0, 3), seed: 61 });
  assert.equal(restoreMatch(fewer.m, doc, { createRngFromState }), false);
  const old = makeMatch({ seats: doc.seats, seed: 61 });
  assert.equal(restoreMatch(old.m, { ...doc, v: SNAPSHOT_VERSION + 1 }, { createRngFromState }), false);
  h.run(() => h.m.phase === PHASE.COMBAT);
  assert.equal(canSnapshot(h.m), false);
  assert.equal(snapshotMatch(h.m), null);
});

test('the match offers its safe points: drafts and the prep end (before the end changes anything)', () => {
  const seen = [];
  const h = makeMatch({ humans: 1, bots: 3, seed: 71 }).autoHumans();
  h.m.opts.onCheckpoint = (m, reason) => {
    seen.push(reason);
    if (reason === 'prep-end') {
      assert.equal(m.phase, PHASE.PREP);
      assert.ok(canSnapshot(m));
      assert.ok(snapshotMatch(m));
    }
  };
  h.start();
  h.runToPhase(PHASE.PREP, 3);
  assert.ok(seen.includes('band-draft'));
  assert.ok(seen.filter((r) => r === 'prep-end').length >= 2);
  assert.equal(CHECKPOINT_PREP_END, 'prep-end');
});

test('a restore from the prep end replays the round: m.public names it through that prep only', () => {
  let doc = null;
  const h = makeMatch({ humans: 1, bots: 3, seed: 73 }).autoHumans();
  h.m.opts.onCheckpoint = (m, reason) => { if (reason === CHECKPOINT_PREP_END && m.round === 2 && !doc) doc = snapshotMatch(m); };
  h.start();
  h.run(() => h.m.round === 2 && h.m.phase === PHASE.COMBAT);
  assert.ok(doc, 'the prep end of round 2 was checkpointed');
  assert.equal(h.m.publicView().replayRound, undefined, 'a match that never restarted names nothing');
  const r = restored(doc, { replay: true });
  assert.equal(r.m.phase, PHASE.PREP);
  assert.equal(r.m.round, 2);
  assert.equal(r.m.replayRound, 2);
  assert.equal(r.m.publicView().replayRound, 2);
  r.autoHumans();
  r.run(() => r.m.phase !== PHASE.PREP);
  assert.equal(r.m.round, 2);
  assert.equal(r.m.publicView().replayRound, undefined, 'gone once the round\'s battle starts again');
  r.run(() => r.m.round === 3 && r.m.phase === PHASE.PREP);
  assert.equal(r.m.publicView().replayRound, undefined, 'and the next prep is an ordinary one');
  // a checkpoint taken during the prep (the periodic round, a shutdown) resumes the prep: nothing is fought again
  assert.equal(restored(doc).m.publicView().replayRound, undefined);
  assert.equal(restored(doc, { replay: false }).m.replayRound, 0);
});

test('a seat under 掉线由 AI 接管 is restored under it, and its player\'s return hands it back', () => {
  const h = makeMatch({ humans: 2, bots: 2, seed: 81 });
  h.start();
  h.m.onDisconnect('p_1');
  h.drive(() => h.m.players.get('p_1').offlineAutoplay && h.m.phase === PHASE.PREP && canSnapshot(h.m));
  assert.ok(h.m.round > OFFLINE_TAKEOVER_ROUNDS);
  const r = restored(snapshotMatch(h.m), {});
  const ps = r.m.players.get('p_1');
  assert.equal(ps.offlineAutoplay, true);
  assert.equal(ps.autoplay, true);
  assert.equal(ps.ready, true, 'an AI-driven seat stays Ready');
  r.m.onReconnect('p_1');
  assert.equal(ps.offlineAutoplay, false);
  assert.equal(ps.autoplay, false);
});

test('a twenty-seat prep restores losslessly and plays on identically to the next prep end', { timeout: 120_000 }, () => {
  const cfg = { humans: 3, bots: 17, seed: 91, experimental: twenty };
  const h = makeMatch(cfg).autoHumans();
  h.start();
  h.run(() => h.ended != null || (h.m.phase === PHASE.PREP && h.m.round >= 3 && canSnapshot(h.m)));
  const doc = snapshotMatch(h.m);
  assert.ok(JSON.stringify(doc).length < 2_000_000);
  const r = restored(doc, cfg);
  assert.deepEqual(matchState(r.m), matchState(h.m));
  for (const ps of r.m.order) if (!ps.isBot) r.m.onReconnect(ps.playerId);
  const round = h.m.round;
  h.run(() => h.ended != null || (h.m.phase === PHASE.COMBAT && h.m.round === round));
  r.run(() => r.ended != null || (r.m.phase === PHASE.COMBAT && r.m.round === round));
  const strip = (x) => { const { match, ...rest } = x; const { errors, errorCount, lastResults, simErrorLog, ...m } = match; return { ...rest, match: m }; };
  assert.deepEqual(strip(matchState(r.m)), strip(matchState(h.m)));
});

test('a checkpoint holding what the game data no longer has (another release) is refused', () => {
  const h = makeMatch({ humans: 1, bots: 3, seed: 101 }).autoHumans();
  h.start();
  h.run(() => h.ended != null || (h.m.phase === PHASE.PREP && h.m.round >= 2 && canSnapshot(h.m)));
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  const p = doc.players.find((x) => decodeValue(x.f.board).size > 0);
  const board = decodeValue(p.f.board);
  const [key, piece] = [...board][0];
  board.set(key, { ...piece, id: 'chess_removed_in_a_later_release' });
  p.f.board = encodeValue(board);
  const r = makeMatch({ seats: doc.seats, seed: doc.seed });
  assert.equal(restoreMatch(r.m, doc, { createRngFromState }), false);
  const s2 = makeMatch({ seats: doc.seats, seed: doc.seed });
  assert.equal(restoreMatch(s2.m, { ...JSON.parse(JSON.stringify(snapshotMatch(h.m))), match: { ...doc.match, stageId: 'no_such_stage' } }, { createRngFromState }), false);
});
