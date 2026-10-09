// The cluster's real Match actor preserves reusable draft snapshots and fences stale bindings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameHost } from '../server/cluster/game-host.js';
import { Match } from '../server/match/Match.js';
import { DATA } from './match/harness.js';
import { ERR } from '../shared/constants.js';
import { until } from './match/combat-fixtures.js';

const channel = () => ({ messages: [], send(m) { this.messages.push(m); return true; }, sendEncoded(t, bytes) { this.messages.push(JSON.parse(bytes)); return true; }, close() {} });
const options = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 };
for (const family of ['bounty', 'tactic']) test(`cluster ${family} real actor retains same-band/same-idx0 snapshots across owner replacement`, async t => {
  class RepeatMatch extends Match {
    constructor(opts) {
      const choices = opts.data.choices, mode = choices.schedule.mode_multi_normal;
      const data = { ...opts.data, choices: { ...choices, schedule: { ...choices.schedule,
        mode_multi_normal: { ...mode, rounds: { ...mode.rounds, 3: { ...mode.rounds[3], families: [{ family, weight: 1 }] } } } } } };
      super({ ...opts, data, clientCombat: false, botRehearsal: 0 });
    }
  }
  const host = new GameHost({ data: DATA, MatchClass: RepeatMatch }); t.after(() => host.close());
  const spec = { assignmentId: `repeated-${family}`, roomCode: 'ABCD', build: 'local-repeat-build', protocol: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seed: 19, matchNo: 1, experimental: options,
    seats: Array.from({ length: 20 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `Player${seat}`, connected: true, isBot: false })), spectators: ['observer'] };
  host.prepare(spec); const channels = new Map([...spec.seats.map(s => s.playerId), 'observer'].map(id => [id, channel()]));
  for (const [id, c] of channels) host.bind(spec.assignmentId, id, c); host.commit(spec.assignmentId);
  const match = host.contexts.get(spec.assignmentId).match;
  for (const seat of spec.seats) assert.deepEqual(host.handle(spec.assignmentId, seat.playerId, { t: 'g.infoReady' }, channels.get(seat.playerId)), { ok: true });
  await until(() => match.phase === 'BAND_DRAFT');
  assert.equal(match.publicView().draft.allowRepeat, true);
  while (match.draftTurn()) { const id = match.draftTurn(); assert.deepEqual(host.handle(spec.assignmentId, id, { t: 'g.band', bandId: 'band_bldsk' }, channels.get(id)), { ok: true }); }
  await until(() => match.phase === 'BATTLE_CHECK');
  assert.equal(Object.keys(match.draft.picks).length, 20); assert.equal(new Set(Object.values(match.draft.picks)).size, 1);
  match.setDeadline(0); match.round = 3; match.enterSpDraft(); const draft = match.sp;
  assert.equal(match.publicView().sp.allowRepeat, true); assert.equal(draft.cards.length, 6);
  for (let i = 0; i < 7; i++) { const id = match.spTurn(); assert.deepEqual(host.handle(spec.assignmentId, id, { t: 'g.choice', idx: 0 }, channels.get(id)), { ok: true }); }
  const old = channels.get('p19'), replacement = channel(); host.bind(spec.assignmentId, 'p19', replacement); channels.set('p19', replacement);
  assert.equal(host.handle(spec.assignmentId, 'p19', { t: 'g.choice', idx: 0 }, old).error, ERR.NOT_IN_ROOM);
  const snapshot = replacement.messages.findLast(m => m.t === 'm.public');
  assert.equal(snapshot.sp.allowRepeat, true); assert.equal(snapshot.sp.cards.length, 6); assert.deepEqual(snapshot.sp.picks, draft.picks);
  while (match.spTurn()) { const id = match.spTurn(); assert.deepEqual(host.handle(spec.assignmentId, id, { t: 'g.choice', idx: 0 }, channels.get(id)), { ok: true }); }
  await until(() => match.phase === 'PREP');
  assert.equal(Object.keys(draft.picks).length, 20); assert.ok(Object.values(draft.picks).every(idx => idx === 0));
  for (const [id, c] of channels) {
    const personal = c.messages.filter(m => m.t === 'm.private');
    if (id === 'observer') assert.equal(personal.length, 0);
    else assert.ok(personal.every(m => m.playerId === id));
  }
  assert.equal(host.member(spec.assignmentId, 'p19').role, 'player'); assert.equal(match.errorCount, 0);
});
