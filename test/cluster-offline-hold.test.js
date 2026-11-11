// The offline hold on the cluster path (server/match/match/offlineHold.js): the game node's actor (GameHost + a real
// Match) holds when every player's game channel is gone — a spectator's channel does not keep it running —, the first
// player that binds again releases it, and nobody back clears it on the node itself: the match ends 'abandoned' and the
// coordinator gets the end receipt like for any other end. Real wall clock with a short hold (Match opts.offlineHoldMs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameHost } from '../server/cluster/game-host.js';
import { Match } from '../server/match/Match.js';
import { getData } from '../server/data.js';
import { PHASE } from '../shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seat = (seat, playerId, extra = {}) => ({ seat, playerId, name: playerId, isBot: false, connected: true, ...extra });
const spec = () => ({ assignmentId: 'assignment-hold', roomCode: 'HOLD', build: 'test-build', protocol: 1,
  seed: 81, matchNo: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal',
  seats: [seat(0, 'p1'), seat(1, 'p2'), seat(2, 'ai_1', { isBot: true })], spectators: ['s1'], snapshotHz: 10 });
const channel = () => ({ sent: [], closed: [],
  send(msg) { this.sent.push(msg); return true; },
  sendEncoded() { return true; },
  close(code, reason) { this.closed.push([code, reason]); } });

test('GameHost: every player channel gone holds the match, a rebind releases it, nobody back ends it on the node with a receipt', { timeout: 60_000 }, async (t) => {
  const HOLD_MS = 400;
  class ShortHold extends Match { constructor(opts) { super({ ...opts, offlineHoldMs: HOLD_MS }); } }
  const receipts = [];
  const host = new GameHost({ data: getData({ log: { warn() {}, error() {}, info() {} } }), MatchClass: ShortHold, prepareMs: 5000,
    log: { error() {} }, onEnd: (receipt) => { receipts.push(receipt); } });
  t.after(() => host.close());
  const handle = host.prepare(spec());
  const channels = { p1: channel(), p2: channel(), s1: channel() };
  const unbind = {};
  for (const [id, transport] of Object.entries(channels)) unbind[id] = host.bind(handle.assignmentId, id, transport);
  host.commit(handle.assignmentId);
  const m = host.contexts.get(handle.assignmentId).match;
  assert.equal(m.phase, PHASE.INFO_CHECK);
  assert.equal(m.offlineHoldMs, HOLD_MS);

  unbind.p2();
  assert.equal(m._offline, false, 'one player still bound');
  unbind.p1();
  assert.equal(m._offline, true, 'no player bound: held, although the spectator still watches');
  const left = m.deadline - m.sched.now();
  await sleep(HOLD_MS / 2);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  unbind.p1 = host.bind(handle.assignmentId, 'p1', channels.p1 = channel());
  assert.equal(m._offline, false, 'the first player back releases it');
  assert.ok(Math.abs(m.deadline - m.sched.now() - left) < 50, 'its countdown went on from where it stopped');
  assert.ok(channels.p1.sent.some((x) => x.t === 'm.public' && x.paused === false), 'the resync shows the running match');

  unbind.p1();
  assert.equal(m._offline, true);
  await sleep(HOLD_MS + HOLD_MS / 10 + 300);
  assert.equal(receipts.length, 1, 'cleared: one end receipt for the coordinator');
  assert.equal(receipts[0].assignmentId, handle.assignmentId);
  assert.equal(receipts[0].summary.reason, 'abandoned');
  assert.equal(m.offlineCleared, true);
  assert.equal(host.get(handle.assignmentId).state, 'ended');
});
