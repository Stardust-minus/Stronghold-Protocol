import test from 'node:test';
import assert from 'node:assert/strict';
import { ChoiceView, cardPickable } from '../../public/js/ui/choiceOverlay.js';
import { normalizeSp } from '../../public/js/ui/gameLogic.js';

const players = Array.from({ length: 8 }, (_, i) => ({ playerId: `p${i}`, name: `Player ${i}`, seat: i }));
const cards = Array.from({ length: 6 }, (_, i) => ({ name: `Choice ${i}`, desc: `Effect ${i}` }));
const pub = { players };
function nodes(v, out = []) {
  if (Array.isArray(v)) { for (const x of v) nodes(x, out); }
  else if (v && typeof v === 'object' && v.props) { out.push(v); nodes(v.props.children, out); }
  return out;
}
const hasClass = (v, c) => String(v.props.class || '').split(' ').includes(c);
function text(v) {
  if (Array.isArray(v)) return v.map(text).join('');
  if (v && typeof v === 'object') return text(v.props?.children);
  return v == null || typeof v === 'boolean' ? '' : String(v);
}
function view(picks, allowRepeat = true) {
  const sp = normalizeSp({ family: 'bounty', cards, order: players.map(p => p.playerId), turn: 'p3', picks,
    ...(allowRepeat ? { allowRepeat: true } : {}) }, players);
  return { sp, all: nodes(ChoiceView({ pub, sp, myId: 'p3', solo: false })) };
}

test('repeat Improv shows each teammate choice and every picker on a shared card', () => {
  const { sp, all } = view({ p0: 2, p1: 2, p2: 5 });
  const labels = all.filter(v => hasClass(v, 'spov__wpick'));
  assert.deepEqual(labels.map(v => [v.props['data-picked-idx'], text(v)]), [[2, 'Choice 2'], [2, 'Choice 2'], [5, 'Choice 5']]);
  const shared = all.find(v => v.type === 'button' && v.props['data-card-idx'] === 2);
  assert.equal(shared.props.disabled, false, 'a teammate pick must not take the repeat card away');
  assert.equal(hasClass(shared, 'is-taken'), false);
  assert.match(shared.props['aria-label'], /Player 0.*Player 1/);
  const summary = nodes(shared).find(v => hasClass(v, 'spcard__pickers'));
  assert.equal(summary.props['data-picked-count'], 2);
  assert.equal(text(summary), 'Player 0、Player 1 已选择');
  assert.equal(cardPickable(sp, sp.cards[2], { myId: 'p0', solo: false }), false, 'each player still picks once');
});

test('exclusive Improv keeps its single taker badge and displays their choice in the order', () => {
  const { all } = view({ p0: 2 }, false);
  const taken = all.find(v => v.type === 'button' && v.props['data-card-idx'] === 2);
  assert.equal(taken.props.disabled, true);
  assert.equal(hasClass(taken, 'is-taken'), true);
  assert.equal(nodes(taken).filter(v => hasClass(v, 'spcard__taker')).length, 1);
  assert.equal(all.filter(v => hasClass(v, 'spcard__pickers')).length, 0);
  assert.equal(text(all.find(v => hasClass(v, 'spov__wpick'))), 'Choice 2');
});

test('missing, out-of-range and non-participant picks cannot create a teammate selection', () => {
  const { all } = view({ p0: 99, p1: -1, p2: '2', outsider: 2 });
  assert.equal(all.filter(v => hasClass(v, 'spov__wpick')).length, 0);
  assert.equal(all.filter(v => hasClass(v, 'spcard__pickers')).length, 0);
});

test('a new draft replaces visible choices instead of retaining the previous draft', () => {
  assert.equal(view({ p0: 2 }).all.filter(v => hasClass(v, 'spov__wpick')).length, 1);
  assert.equal(view({}).all.filter(v => hasClass(v, 'spov__wpick')).length, 0);
});
