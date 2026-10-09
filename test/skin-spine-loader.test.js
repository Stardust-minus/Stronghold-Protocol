import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSpineData } from '../public/js/assets.js';

function fixture(t, load) {
  const previous = globalThis.PIXI;
  globalThis.PIXI = { spine: {}, Assets: { load } };
  t.after(() => { if (previous === undefined) delete globalThis.PIXI; else globalThis.PIXI = previous; });
}

for (const atlas of [undefined, '/assets/base.atlas']) test(`ordinary Spine loading preserves its original URL API (${atlas || 'inferred'})`, async t => {
  const calls = [], data = { animations: [{ name: 'Idle' }] };
  fixture(t, async source => { calls.push(source); return { spineData: data }; });
  assert.equal(await loadSpineData({ skel: '/assets/base.skel', ...(atlas ? { atlas } : {}) }), data);
  assert.deepEqual(calls, ['/assets/base.skel']);
});

test('display skeleton loads the explicitly admitted atlas, never a guessed display atlas', async t => {
  const calls = [], data = { animations: [{ name: 'Idle' }] };
  const entry = Object.freeze({ skel: '/assets/skins/skin/front/skin.display.skel', atlas: '/assets/skins/skin/front/skin.atlas' });
  fixture(t, async source => { calls.push(source); return { spineData: data }; });
  assert.equal(await loadSpineData(entry), data);
  assert.deepEqual(calls, [{ src: entry.skel, data: { spineAtlasFile: entry.atlas } }]);
  assert.deepEqual(Object.keys(entry), ['skel', 'atlas']);
});

test('explicit atlas failures propagate rather than pretending a default appearance loaded', async t => {
  const entry = { skel: '/skin.display.skel', atlas: '/skin.atlas' };
  fixture(t, async source => { assert.equal(source.data.spineAtlasFile, entry.atlas); throw new Error('atlas unavailable'); });
  await assert.rejects(loadSpineData(entry), /atlas unavailable/);
});
