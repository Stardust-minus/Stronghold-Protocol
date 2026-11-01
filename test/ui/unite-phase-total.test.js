import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { phaseTotalSeconds } from '../../public/js/ui/gameLogic/phases.js';

const config = { modes: { coop: { rounds: { 3: { combatTimeLimit: 30 } } } } };
const pub = (phase = PHASE.UNITE, extra = {}) => ({ phase, modeId: 'coop', round: 3, unite: {}, ...extra });

test('联防 and combat read the round\'s limit in every room size', () => {
  for (const playerCapacity of [4, 8, 12, 16, 20]) {
    assert.equal(phaseTotalSeconds(pub(PHASE.UNITE, { playerCapacity }), config), 30);
    assert.equal(phaseTotalSeconds(pub(PHASE.COMBAT, { playerCapacity }), config), 30);
  }
});

test('the 联防 budget note is gone from the screen', () => {
  const read = (p) => readFileSync(new URL(`../../public/${p}`, import.meta.url), 'utf8');
  for (const p of ['js/ui/hud.js', 'js/screens/game.js', 'js/ui/gameLogic/phases.js', 'css/screens/game.css', 'css/screens/team.css']) {
    assert.doesNotMatch(read(p), /uniteBudget|UniteBudget|unite-budget|gtop__budget/, p);
  }
  for (const lang of ['en', 'ja', 'ko', 'zh-TW']) assert.doesNotMatch(read(`i18n/${lang}.json`), /联防总预算|本轮起始剩余/, lang);
});
