import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakePixi } from './fakepixi.js';
import { SpineActor } from '../../public/js/render/spine.js';

const manifest = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));

test('a freshly loaded Archetto skin poses its real Idle before the first draw without playing Default or Start', () => {
  const fake = installFakePixi();
  const Original = globalThis.PIXI.spine.Spine;
  const calls = [];
  globalThis.PIXI.spine.Spine = class extends Original {
    update(dt) { calls.push({ dt, track: this.state.tracks[0]?.animation.name, time: this.state.tracks[0]?.trackTime }); this.posed = true; }
  };
  try {
    for (const side of ['front', 'back']) {
      calls.length = 0;
      const entry = manifest.skins.char_332_archet_sale_14.spine[side];
      const a = new SpineActor({ animations: Object.keys(entry.animations).map(name => ({ name })) }, entry);
      assert.deepEqual(calls, [{ dt: 0, track: 'Idle', time: 0 }]);
      assert.equal(a.spine.posed, true);
      assert.equal(a.spine.autoUpdate, false);
      assert.equal(a.mode, 'base'); assert.equal(a.current, 'Idle'); assert.equal(a.clock, 0);
      assert.equal(a.skillOn, false); assert.equal(a.dead, false);
      a.destroy();
    }
  } finally { fake.restore(); }
});

test('immediate posing keeps the selected resting clip of a non-Archetto skeleton', () => {
  const fake = installFakePixi();
  const Original = globalThis.PIXI.spine.Spine;
  const calls = [];
  globalThis.PIXI.spine.Spine = class extends Original {
    update(dt) { calls.push([dt, this.state.tracks[0]?.animation.name]); }
  };
  try {
    const a = new SpineActor({ animations: [{ name: 'Rest' }, { name: 'Idle' }] }, { anims: { idle: 'Rest' }, animations: { Rest: 2 } });
    assert.deepEqual(calls, [[0, 'Rest']]);
    assert.equal(a.clock, 0); assert.equal(a.current, 'Rest'); a.destroy();
  } finally { fake.restore(); }
});
