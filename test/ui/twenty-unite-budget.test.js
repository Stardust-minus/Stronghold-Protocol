import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { phaseTotalSeconds, countdownState, uniteBudgetInfo } from '../../public/js/ui/gameLogic/phases.js';
import { UniteBudgetNote } from '../../public/js/ui/hud.js';

const config = { modes: { coop: { rounds: { 3: { combatTimeLimit: 30 } } } } };
const pub = (unite = {}) => ({ phase: PHASE.UNITE, modeId: 'coop', round: 3, unite });
const budget = { timeLimit: 150, gameSpeed: 2, totalBudget: 300, remainingBudget: 300 };
const text = n => Array.isArray(n) ? n.map(text).join('') : n?.props ? text(n.props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';

test('the current unite gauge uses round game seconds / its actual speed, never the whole-stage balance', () => {
  for (const speed of [0.25, 1, 2, 3.5, 10]) {
    assert.equal(phaseTotalSeconds(pub({ ...budget, gameSpeed: speed }), config), 150 / speed);
  }
  const total = phaseTotalSeconds(pub(budget), config), start = 100000;
  assert.equal(total, 75);
  assert.deepEqual(countdownState(start + total * 1000, start, total), { remain: 75, warn: false, bars: 5, text: '75', frac: 1 });
  assert.equal(countdownState(start + total * 1000, start + 35000, total).frac, 40 / 75);
  assert.equal(phaseTotalSeconds(pub({ ...budget, timeLimit: 280, remainingBudget: 280 }), config), 140, 'a short first round leaves its unused time for round two');
});

test('legacy unite and normal combat keep their original config timing', () => {
  for (const capacity of [4, 8, 12, 16]) {
    assert.equal(phaseTotalSeconds({ ...pub(), playerCapacity: capacity }, config), 30);
    assert.equal(UniteBudgetNote({ pub: { ...pub(), playerCapacity: capacity } }), null);
  }
  assert.equal(phaseTotalSeconds({ ...pub(budget), phase: PHASE.COMBAT }, config), 30);
  assert.equal(uniteBudgetInfo({ ...pub(budget), phase: PHASE.SETTLE }), null);
  for (const bad of [undefined, null, 0, -1, Infinity, NaN, '2', true]) {
    assert.equal(phaseTotalSeconds(pub({ ...budget, gameSpeed: bad }), config), 30);
    assert.equal(phaseTotalSeconds(pub({ ...budget, timeLimit: bad }), config), 30);
  }
});

test('budget copy explicitly describes a game-second round-start snapshot, separate from the real-time clock', () => {
  const input = pub({ ...budget, remainingBudget: 281.25 });
  const before = structuredClone(input);
  assert.deepEqual(uniteBudgetInfo(input), { total: 300, remaining: 281.25 });
  const note = UniteBudgetNote({ pub: input });
  assert.equal(note.props['data-testid'], 'unite-budget');
  assert.equal(note.props['data-total'], 300);
  assert.equal(note.props['data-remaining'], 281.25);
  assert.match(text(note), /联防总预算：300 游戏秒/);
  assert.match(text(note), /本轮起始剩余：281.25 游戏秒/);
  assert.deepEqual(input, before);
  assert.equal(UniteBudgetNote({ pub: { ...input, phase: PHASE.PREP } }), null);
});

test('missing and malformed budget values never create misleading budget text', () => {
  for (const unite of [{}, { totalBudget: '300', remainingBudget: 200 }, { totalBudget: 300, remainingBudget: '200' },
    { totalBudget: 300, remainingBudget: -1 }, { totalBudget: 300, remainingBudget: 301 }, { totalBudget: Infinity, remainingBudget: 200 },
    { totalBudget: 0, remainingBudget: 0 }]) assert.equal(UniteBudgetNote({ pub: pub(unite) }), null);
  assert.deepEqual(uniteBudgetInfo(pub({ totalBudget: 300, remainingBudget: 0 })), { total: 300, remaining: 0 });
});

test('budget layout uses an explicit authority-derived class, not unsupported relational CSS selectors', () => {
  const css = readFileSync(new URL('../../public/css/screens/game.css', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /:has\(/);
  assert.match(css, /\.gm--expanded\.gm--unite-budget \.gtop/);
  assert.match(screen, /uniteBudgetInfo\(pub\) && 'gm--unite-budget'/);
});
