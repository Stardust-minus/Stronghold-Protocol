// 多人匹配's scope on the page: what is remembered, what a press does, what queue.join carries, what the search shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_SCOPE_DEFAULT, matchScope, matchScopeRequest, multiSeats, queueCapacity, queueScope, toggleMatchScope } from '../../public/js/ui/matchmaking.js';

test('the default is the ordinary game: four seats, standard rules', () => {
  assert.deepEqual(matchScope(undefined), { seats: ['four'], rules: ['standard'] });
  assert.deepEqual(matchScopeRequest(matchScope(MATCH_SCOPE_DEFAULT)), { capacities: [4], rules: ['standard'] });
  assert.deepEqual(multiSeats(), { a: 8, b: 20 });
});

test('a saved scope is checked, each axis on its own', () => {
  assert.deepEqual(matchScope({ seats: ['multi'], rules: ['experimental', 'standard'] }), { seats: ['multi'], rules: ['standard', 'experimental'] });
  assert.deepEqual(matchScope({ seats: [], rules: ['odd'] }), { seats: ['four'], rules: ['standard'] });
  assert.deepEqual(matchScope({ seats: 'multi' }), { seats: ['four'], rules: ['standard'] });
  assert.deepEqual(matchScope('x'), { seats: ['four'], rules: ['standard'] });
});

test('a press toggles, and the last choice of an axis stays', () => {
  let scope = matchScope(undefined);
  assert.equal(toggleMatchScope(scope, 'seats', 'four'), scope, 'the only one stays');
  scope = toggleMatchScope(scope, 'seats', 'multi');
  assert.deepEqual(scope.seats, ['four', 'multi']);
  scope = toggleMatchScope(scope, 'seats', 'four');
  assert.deepEqual(scope.seats, ['multi']);
  scope = toggleMatchScope(scope, 'rules', 'experimental');
  assert.deepEqual(scope.rules, ['standard', 'experimental']);
  assert.deepEqual(matchScopeRequest(scope), { capacities: [8, 12, 16, 20], rules: ['standard', 'experimental'] });
  assert.deepEqual(matchScopeRequest(toggleMatchScope(scope, 'seats', 'four')).capacities, [4, 8, 12, 16, 20]);
});

test('the search names what a lone ticket waits for', () => {
  const queued = { state: 'queued', required: 4, rules: ['standard'] };
  assert.deepEqual(queueScope(queued), { seats: null, rules: '标准规则' });
  assert.deepEqual(queueScope({ ...queued, capacities: [4, 8, 12, 16, 20] }), { seats: '4 人、多人同盟', rules: '标准规则' });
  assert.deepEqual(queueScope({ ...queued, required: 8, capacities: [8, 12, 16, 20], rules: ['experimental'] }), { seats: '多人同盟', rules: '仅实验性规则' });
  assert.deepEqual(queueScope({ state: 'queued', required: 4, capacities: [4, 8], partyRoomCode: null }), { seats: '4 人、多人同盟', rules: '含实验性规则' });
});

test('a room\'s party and a standing offer add nothing: the size and the rules are the game\'s', () => {
  assert.equal(queueScope({ state: 'queued', required: 8, partyRoomCode: 'ABCD' }), null);
  assert.equal(queueScope({ state: 'offered', required: 8, capacities: [8, 12], rules: ['standard'] }), null);
  assert.equal(queueScope(null), null);
  assert.equal(queueCapacity({ state: 'offered', required: 12, capacities: [8, 12] }), 12, 'the offer shows its real size');
});
