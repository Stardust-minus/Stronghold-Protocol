// Where a match's private secret comes from (server/match/secret.js, docs/history/0.4.0.md §37.277): the lobby draws a
// fresh one for every match (never the seed's), a lobby given a seedFn (tests) and a test room take the seed's, a restore
// passes the checkpoint's; a game node's new actor draws its own and a restored one is built with its checkpoint's; a
// version host's options carry it. Nothing of it is in a cluster assignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { GameHost } from '../server/cluster/game-host.js';
import { wireOptions } from '../server/match/host/proxy.js';
import { isMatchSecret, newMatchSecret, seedSecret } from '../server/match/secret.js';

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

function lobbyOf(t, extra = {}) {
  const started = [];
  class Rec {
    constructor(opts) { this.opts = opts; started.push(opts); }
    start() {}
    dispose() {}
  }
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, log: QUIET, MatchClass: Rec, getData: () => ({}), ...extra,
    options: { testMode: extra.testMode ?? 'off', testHost: extra.testHost } });
  t.after(() => lobby.shutdown());
  let n = 0;
  const player = () => {
    const s = registry.create(`P${++n}`);
    s.connected = true; s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send: (txt) => s.messages.push(JSON.parse(txt)) };
    return s;
  };
  return { lobby, player, started };
}

test('the lobby draws a fresh secret for every match, never the seed\'s; a fixed seedFn or a test room takes the seed\'s', (t) => {
  const prod = lobbyOf(t);
  for (let i = 0; i < 2; i++) {
    const s = prod.player();
    prod.lobby.create(s, { mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(prod.lobby.startMatch(prod.lobby.roomOf(s)).ok, true);
  }
  const [a, b] = prod.started;
  for (const o of [a, b]) {
    assert.ok(isMatchSecret(o.matchSecret));
    assert.notEqual(o.matchSecret, seedSecret(o.seed), 'not a function of the seed');
  }
  assert.notEqual(a.matchSecret, b.matchSecret);

  const fixed = lobbyOf(t, { seedFn: () => 4242 });
  const s = fixed.player();
  fixed.lobby.create(s, { mode: 'solo', difficulty: 'NORMAL' });
  assert.equal(fixed.lobby.startMatch(fixed.lobby.roomOf(s)).ok, true);
  assert.equal(fixed.started[0].seed, 4242);
  assert.equal(fixed.started[0].matchSecret, seedSecret(4242), 'a test fixing the seed fixes the match');

  const tests = lobbyOf(t, { testMode: '1', testHost: '127.0.0.1' });
  const host = tests.player();
  tests.lobby.create(host, { mode: 'solo', difficulty: 'NORMAL', test: true });
  assert.equal(tests.lobby.startMatch(tests.lobby.roomOf(host)).ok, true);
  const o = tests.started[0];
  assert.equal(o.test, true);
  assert.equal(o.matchSecret, seedSecret(o.seed), 'a test room\'s journal replays from its seed');
});

test('a restore passes its checkpoint\'s secret; a version host\'s options carry it', (t) => {
  const { lobby, player, started } = lobbyOf(t);
  const s = player();
  lobby.create(s, { mode: 'solo', difficulty: 'NORMAL' });
  const room = lobby.roomOf(s);
  const S = newMatchSecret();
  const seats = [{ seat: 0, playerId: s.playerId, name: s.name, isBot: false, connected: false }];
  const res = lobby.startMatch(room, room.ownerKey, null, { restore: { seed: 77, matchNo: 3, seats, spectators: [], matchSecret: S, apply: () => {} } });
  assert.equal(res.ok, true);
  assert.equal(started[0].matchSecret, S);
  assert.equal(started[0].seed, 77);
  assert.equal(wireOptions({ roomCode: 'ABCD', seed: 77, matchSecret: S }).matchSecret, S);
});

test('a game node: a new actor\'s Match draws its own secret (none in the assignment); a restored one gets its checkpoint\'s', (t) => {
  const made = [];
  class FakeMatch {
    constructor(opts) { this.opts = opts; made.push(opts); }
    start() {} dispose() {} onReconnect() {} addSpectator() {}
  }
  const host = new GameHost({ data: {}, MatchClass: FakeMatch, now: () => 1000, prepareMs: 100, log: QUIET });
  t.after(() => host.close());
  const spec = (id) => ({ assignmentId: id, roomCode: 'ABCD', build: 'b', protocol: 1, seed: 71, matchNo: 1, mode: 'coop', difficulty: 'NORMAL',
    modeId: 'mode_multi_normal', seats: [{ seat: 0, playerId: 'p1', name: 'p1', isBot: false, connected: true }, { seat: 1, playerId: 'ai_1', name: 'AI', isBot: true, connected: true }],
    spectators: [], revivalEnabled: false });
  host.prepare(spec('fresh'));
  assert.equal(Object.hasOwn(made[0], 'matchSecret'), false, 'the Match draws its own (Match.js)');
  const S = newMatchSecret();
  // (a fake match is no checkpoint's target: the restore is refused after the actor was built)
  assert.throws(() => host.restore(spec('back'), { match: { matchSecret: S }, left: [] }));
  assert.equal(made[1].matchSecret, S);
});
