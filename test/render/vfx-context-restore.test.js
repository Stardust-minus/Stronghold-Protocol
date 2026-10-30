// test/render/vfx-context-restore.test.js — feedback #58: a lost WebGL context restored by PIXI keeps the same context
// object, so the official effects must notice the new CONTEXT_UID and rebuild their GL objects. The old FxGL's programs
// and VAOs are dead there, and drawing through them took the HP bars and the impostor erasers with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficialFx } from '../../public/js/render/vfx/system.js';

/** A WebGL2 context where every call succeeds: only the object identity of what FxGL builds matters here. */
function fakeGl() {
  return new Proxy({}, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (name === 'getContextAttributes') return () => ({ depth: true });
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      return (target[name] ??= () => ({}));
    },
  });
}

function fixture() {
  const lib = { available: true, dropped: 0, dropImages() { this.dropped++; }, texture: () => null, mesh: () => null };
  const ofx = new OfficialFx({ P: { Container: class {} }, renderer: null, cam: () => null, lib, tier: 'full' });
  ofx.effects.push({});
  ofx._warmStep = () => {};
  ofx._prepare = () => { ofx.prepared = ofx.frameNo; };
  const renderer = { gl: fakeGl(), CONTEXT_UID: 1, context: { webGLVersion: 2 }, batch: { flush() {} } };
  return { ofx, lib, renderer };
}

test('the effect renderer is rebuilt when PIXI restored the context', () => {
  const { ofx, lib, renderer } = fixture();
  ofx.renderPass('ground', renderer);
  const first = ofx.glr;
  assert.ok(first, 'built on the first pass');
  ofx.renderPass('over', renderer);
  assert.equal(ofx.glr, first, 'kept while the context lives');
  assert.equal(lib.dropped, 0);

  renderer.CONTEXT_UID = 2;
  ofx.renderPass('ground', renderer);
  assert.notEqual(ofx.glr, first, 'a new one on the restored context, same gl object');
  assert.equal(lib.dropped, 1, 'the GPU upload records go with it, so the textures are uploaded again');
  assert.equal(ofx.glrContext, 2);
});
