import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTicketAuthority } from '../server/cluster/tickets.js';

const claims = { sessionId: 'player-one', roomCode: 'ABCD', assignmentId: 'allocation-one', nodeId: 'game-one', role: 'player', build: 'test-build', protocol: 1 };

test('small explicit private-peer clock skew does not grant post-expiry grace', () => {
  const key = randomBytes(32);
  const issuer = createTicketAuthority({ key, now: () => 10000, ttlMs: 100 });
  const token = issuer.issue(claims);
  let now = 9990;
  const strict = createTicketAuthority({ key, now: () => now, ttlMs: 100 });
  const receiver = createTicketAuthority({ key, now: () => now, ttlMs: 100, futureSkewMs: 10 });
  assert.equal(strict.verify(token, claims), null);
  assert.ok(receiver.verify(token, claims));
  now = 9989; assert.equal(receiver.verify(token, claims), null);
  now = 10099; assert.ok(receiver.verify(token, claims));
  now = 10100; assert.equal(receiver.verify(token, claims), null);
});

test('future allowance is configuration-only, bounded and does not weaken context verification', () => {
  const key = randomBytes(32);
  for (const futureSkewMs of [-1, NaN, 2001, '1000', 0.5]) {
    assert.throws(() => createTicketAuthority({ key, futureSkewMs }), RangeError);
  }
  const issuer = createTicketAuthority({ key, now: () => 10000 });
  const receiver = createTicketAuthority({ key, now: () => 9000, futureSkewMs: 1000 });
  const token = issuer.issue(claims);
  assert.ok(receiver.verify(token, claims));
  assert.equal(receiver.verify(token, { ...claims, nodeId: 'another-game' }), null);
  assert.equal(receiver.verify(token, { ...claims, role: 'spectator' }), null);
});
