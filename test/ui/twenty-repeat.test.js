import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDraft, normalizeSp } from '../../public/js/ui/gameLogic/draft.js';
import { teammateBands, draftSelection, autoPickBand } from '../../public/js/screens/bandDraft.js';
import { cardPickable, pickBusy, ChoiceView, spTap } from '../../public/js/ui/choiceOverlay.js';

const players = Array.from({ length: 20 }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `Doctor${seat}` }));
const cards = () => Array.from({ length: 6 }, (_, idx) => ({ id: `choice${idx}`, name: `Choice${idx}`, desc: `Effect${idx}` }));
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];

test('only a strict server repeat flag disables strategy exclusivity', () => {
  const picks = Object.fromEntries(players.slice(0, 19).map(p => [p.playerId, 'band_a']));
  const raw = { order: players.map(p => p.playerId), turn: 'p19', picks, allowRepeat: true };
  const draft = normalizeDraft(raw, players);
  assert.equal(draft.allowRepeat, true); assert.equal(draft.picks.size, 19);
  const taken = teammateBands(draft.picks, 'p19', draft.allowRepeat);
  assert.equal(taken.size, 0);
  const bands = [{ bandId: 'band_a' }, { bandId: 'band_b' }];
  const options = { bands, taken, myPick: null, myTurn: true, defaultId: 'band_b' };
  assert.equal(draftSelection('band_a', options), 'band_a');
  assert.equal(autoPickBand('band_a', options), 'band_a');
  for (const value of [undefined, false, 1, 'true', {}]) {
    const legacy = normalizeDraft({ ...raw, allowRepeat: value }, players);
    assert.equal(Object.hasOwn(legacy, 'allowRepeat'), false);
    assert.equal(teammateBands(legacy.picks, 'p19', value).get('band_a').length, 19);
  }
});

for (const family of ['bounty', 'tactic', 'supply', 'shop']) test(`${family}: all twenty players can select the same zero slot in a six-card view`, () => {
  const rawCards = cards(), picks = {};
  for (let turn = 0; turn < players.length; turn++) {
    const myId = players[turn].playerId;
    const raw = { family, cards: rawCards, order: players.map(p => p.playerId), turn: myId, picks, taken: turn ? { 0: 'p0' } : {}, allowRepeat: true };
    const sp = normalizeSp(raw, players);
    assert.equal(sp.allowRepeat, true); assert.equal(sp.cards.length, 6); assert.equal(sp.pickOf.size, turn);
    assert.equal(cardPickable(sp, sp.cards[0], { myId, solo: false }), true);
    const first = spTap(null, 0, true), second = spTap(first.armed, 0, true);
    assert.deepEqual(second, { armed: null, pick: 0 });
    const view = ChoiceView({ pub: { players }, sp, myId, solo: false });
    assert.equal(view.props['data-allow-repeat'], 'true');
    assert.match(view.props.class, /spov--expanded/, 'a long turn list still scrolls with only six cards');
    const buttons = walk(view).filter(n => n.type === 'button' && n.props.class?.includes('spcard--'));
    assert.equal(buttons.length, 6); assert.equal(buttons[0].props.disabled, false);
    assert.doesNotMatch(buttons[0].props.class, /is-taken/);
    assert(walk(view).some(n => n.props['data-testid'] === 'sp-repeat'));
    picks[myId] = second.pick;
    const selected = normalizeSp({ ...raw, picks }, players);
    assert.equal(selected.pickOf.get(myId), 0);
    assert.equal(cardPickable(selected, selected.cards[0], { myId, solo: false }), false, 'each player still picks only once');
  }
  const complete = normalizeSp({ family, cards: rawCards, order: players.map(p => p.playerId), turn: null, picks, taken: { 0: 'p0' }, allowRepeat: true }, players);
  assert.equal(complete.pickedCount, 20);
  assert.equal(complete.pickOf.get('p19'), 0);
  assert.equal(complete.takenBy.get(0), 'p0', 'the first picker remains display compatibility metadata');
  assert.deepEqual(rawCards, cards(), 'normalization never mutates the server templates');
});

test('repeated picks from arrays remain distinct and compatibility takers cannot overwrite a real pick', () => {
  const sp = normalizeSp({ cards: cards(), order: ['p0', 'p1'], picks: [{ playerId: 'p0', idx: 1 }, { playerId: 'p1', idx: 1 }], taken: { 0: 'p0' }, allowRepeat: true }, players);
  assert.equal(sp.pickOf.size, 2); assert.equal(sp.pickOf.get('p0'), 1); assert.equal(sp.pickOf.get('p1'), 1);
  const array = normalizeSp({ cards: cards(), order: ['p0', 'p1'], picks: [0, 0], allowRepeat: true }, players);
  assert.equal(array.pickOf.size, 2); assert.equal(array.pickOf.get('p1'), 0);
});

test('repeatable cards still honor turn, busy state and the current player’s zero-index pick', () => {
  const sp = normalizeSp({ cards: cards(), picks: { p0: 0 }, order: ['p0', 'p1'], turn: 'p1', allowRepeat: true }, players);
  const card = sp.cards[0];
  assert.equal(cardPickable(sp, card, { myId: 'p1', solo: false }), true);
  assert.equal(cardPickable(sp, card, { myId: 'p2', solo: false }), false);
  assert.equal(cardPickable(sp, card, { myId: 'p1', solo: false, busyIdx: 0 }), false);
  assert.equal(cardPickable(sp, card, { myId: 'p0', solo: true }), false);
  assert.equal(pickBusy(0, card, undefined, true), true);
  assert.equal(pickBusy(0, card, 0, true), false);
  assert.equal(pickBusy(0, card, undefined, 'true'), false);
});

test('legacy exclusive-card modes do not inherit the twenty-player repeat behavior', () => {
  for (const count of [4, 8, 12, 16]) {
    const rawCards = Array.from({ length: count + 2 }, (_, idx) => ({ id: `card${idx}` }));
    const sp = normalizeSp({ cards: rawCards, picks: { p0: 0 }, turn: 'p1' }, players.slice(0, count));
    assert.equal(Object.hasOwn(sp, 'allowRepeat'), false);
    assert.equal(sp.cards.length, count + 2);
    assert.equal(cardPickable(sp, sp.cards[0], { myId: 'p1', solo: false }), false);
    assert.equal(cardPickable(sp, sp.cards[1], { myId: 'p1', solo: false }), true);
  }
  for (const value of [false, 1, 'true', {}]) {
    const sp = normalizeSp({ cards: cards(), picks: { p0: 0 }, turn: 'p1', allowRepeat: value }, players);
    assert.equal(cardPickable(sp, sp.cards[0], { myId: 'p1', solo: false }), false);
  }
});
