// The settlement's mode tag (screens/settle.js modePillName, upstream §37.125): 规程's solo ladder names its official mode
// (规程等级 n / 极速模拟, as hud.js ladderName), every other mode its difficulty. This fork keeps its own settlement page
// (LV / 经验, the 20-seat scroller); the upstream test file of that page (test/ui/settle.test.js) is not in this fork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const S = await import('../../public/js/screens/settle.js');
const { data } = await import('../../public/js/data.js');

test('the mode tag names 规程\'s solo ladder like the official settlement (规程等级20), other modes by difficulty', async () => {
  await data.loadAll('config');
  const regulation = JSON.parse(readFileSync(path.join(ROOT, 'data/versions/act3autochess-v3_1/config.json'), 'utf8'));
  assert.equal(S.modePillName({ difficulty: 'ABYSS', modeId: 'mode_multi_abyss' }), '终极模拟');
  assert.equal(S.modePillName({ difficulty: 'HARD' }), '绝境模拟');
  data.setView('config', () => regulation);
  try {
    assert.equal(S.modePillName({ difficulty: 'ABYSS', modeId: 'mode_single_20' }), '规程等级20');
    assert.equal(S.modePillName({ difficulty: 'FAST', modeId: 'mode_single_funny' }), '极速模拟');
    assert.equal(S.modePillName({ difficulty: 'ABYSS', modeId: 'mode_multi_abyss' }), '终极模拟');
    assert.equal(S.modePillName({ difficulty: null, modeId: 'mode_single_20' }), '');
  } finally {
    data.setView('config', null);
  }
});

test('our settlement page hands that name to its mode tag', () => {
  const src = readFileSync(path.join(ROOT, 'public/js/screens/settle.js'), 'utf8');
  assert.match(src, /<\$\{DifficultyTag\} difficulty=\$\{r\.difficulty\} size="lg" name=\$\{modePillName\(r\)\} \/>/);
  assert.match(src, /import \{ ladderName \} from '\.\.\/ui\/hud\.js';/);
});
