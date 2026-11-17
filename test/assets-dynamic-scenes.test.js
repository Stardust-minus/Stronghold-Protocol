// The official 动态立绘 scenes played live (2026-11-17): tools/assets/dynamic-scenes.mjs trims a dyn illust descriptor to
// its always-on part and writes the scene file the game loads (public/js/ui/dynFx.js validSceneFile reads it), names only
// the checked scenes in a manifest body (the release list: `enabled`), and tools/prepare-dynamic-scenes.mjs rewrites
// data/assets.json (hash, stats); the committed registry and data/assets.json agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { idleScene, sceneFile, sceneDeps, sceneFileName, sceneUrl, sceneRel, applyDynamicScenes, loadDynamicScenes, validSceneEntry, SCENE_FIELDS }
  from '../tools/assets/dynamic-scenes.mjs';
import { rewriteManifest, markChecked } from '../tools/prepare-dynamic-scenes.mjs';
import { sceneBatch } from '../tools/local-extract/dyn-scenes-pack.mjs';
import { contentHash } from '../tools/assets/manifest.mjs';
import { validSceneFile } from '../public/js/ui/dynFx.js';

const T = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
const mat = (shader, ...tex) => ({ name: shader, shader, textures: Object.fromEntries(tex.map((k, i) => [`_T${i}`, { tex: k, st: [1, 1, 0, 0] }])) });
/** root (DynIllust: node 1 idle, node 2 interact) → 1 (particles, mat 0), 2 → 3 (particles, mat 1, mesh m_act), 4 (mesh m_on, mat 2, Animator) */
function desc() {
  return {
    format: 'fx-prefab', version: 1, key: 'dyn_illust_x#1',
    nodes: [
      { id: 0, name: 'root', parent: null, children: [1, 2, 4], active: true, ...T, meshRenderer: { materials: [3] },
        behaviours: [{ class: 'DynIllust', fields: { _cameraSize: 10, _particles: [{ action: 0, particle: { node: 1 } }, { action: 3, particle: { node: 2 } }] } }] },
      { id: 1, name: 'idle', parent: 0, children: [], active: true, ...T, particleSystem: { looping: true }, particleSystemRenderer: { materials: [0] } },
      { id: 2, name: 'interact', parent: 0, children: [3], active: true, ...T, behaviours: [{ class: 'FxDelay', fields: {} }] },
      { id: 3, name: 'burst', parent: 2, children: [], active: true, ...T, particleSystem: { looping: false },
        particleSystemRenderer: { materials: [1], m_Mesh: 'm_act' }, animator: { clips: [2], default: 0 } },
      { id: 4, name: 'layer', parent: 0, children: [], active: false, ...T, meshFilter: 'm_on', meshRenderer: { materials: [2] }, animator: { clips: [0, 1, 2], default: 0 } },
    ],
    materials: [mat('Torappu/Particles-L2D/Additive', 'a', 'shared'), mat('Torappu/Particles-L2D/Additive', 'b', 'shared'),
      mat('Torappu/Particles-L2D/AlphaBlend', 'c'), mat('Torappu/Spine/L2D/Skeleton'), mat('Torappu/Particles-L2D/AlphaBlend', 'unnamed')],
    clips: [{ name: 'c0', curves: [{ node: 4 }], events: [] }, { name: 'c1', curves: [{ node: 4 }], events: [] }, { name: 'c2', curves: [{ node: 4 }], events: [{ t: 1 }] }],
    textures: ['a', 'b', 'c', 'shared', 'unnamed'], meshes: ['m_act', 'm_on', 'builtin:Quad'],
    dyn: { illust: { cameraSize: 10 }, spine: { scale: 0.01, separatorSlotNames: [] }, animatorStates: { 4: { default: { state: 's1', clip: 'c1' } } } },
  };
}

test('idleScene: the action groups keep only their place, their own materials\' textures and meshes go, an Animator keeps its default clips', () => {
  const input = desc(); const before = JSON.stringify(input);
  const { desc: d, cut } = idleScene(input);
  assert.equal(JSON.stringify(input), before, 'the input is not changed');
  assert.deepEqual(d.nodes[2], { id: 2, name: 'interact', parent: 0, children: [3], active: true, ...T }, 'an action root: hierarchy only');
  assert.deepEqual(d.nodes[3], { id: 3, name: 'burst', parent: 2, children: [], active: true, ...T }, 'and what is under it');
  assert.ok(d.nodes[1].particleSystem && d.nodes[4].meshRenderer, 'the idle group and an inactive node (a clip may turn it on) stay whole');
  assert.deepEqual(d.textures, ['a', 'c', 'shared', 'unnamed'], 'b only the action\'s; shared also the idle\'s; unnamed: a material nothing uses is kept');
  assert.deepEqual(d.meshes, ['m_on', 'builtin:Quad']);
  assert.deepEqual(cut, { nodes: 2, clips: 1, textures: ['b'], meshes: ['m_act'] });
  assert.equal(d.clips[0].curves.length, 1, 'the Animator\'s own default');
  assert.equal(d.clips[1].curves.length, 1, 'DynIllust\'s default state for it');
  assert.deepEqual([d.clips[2].curves, d.clips[2].events], [[], []], 'another state\'s clip');
  assert.equal(d.nodes.length, input.nodes.length, 'node indices unchanged');
});

test('sceneFile: every texture and mesh named with its URL; dynFx.js reads it; a file nobody has is an error', () => {
  const { desc: d } = idleScene(desc());
  const tex = (k) => ({ url: `/assets/~${'0'.repeat(16)}/local/dynfx/tex/${k}.webp`, w: 64, h: 32, wrapU: 'repeat', wrapV: 'clamp', filter: 'bilinear', mips: 7 });
  const mesh = (k) => `/assets/~${'1'.repeat(16)}/local/dynfx/mesh/${k}.json`;
  const f = sceneFile(d, { tex, mesh });
  assert.equal(f.format, 'dyn-scene'); assert.equal(f.version, 1); assert.equal(f.key, 'dyn_illust_x#1');
  assert.deepEqual(Object.keys(f.textures), d.textures);
  assert.deepEqual(f.textures.c, { path: tex('c').url, w: 64, h: 32, wrapU: 'repeat', wrapV: 'clamp', filter: 'bilinear', mips: 7 });
  assert.deepEqual(f.meshes, { m_on: mesh('m_on') }, 'built-in meshes are generated');
  assert.ok(validSceneFile(JSON.parse(JSON.stringify(f))), 'the runtime accepts it');
  assert.ok(!validSceneFile({ ...f, version: 2 }) && !validSceneFile({ ...f, textures: { ...f.textures, c: { path: 'http://x/c.webp' } } }));
  assert.deepEqual(sceneDeps(f).sort(), ['local/dynfx/mesh/m_on.json', ...d.textures.map((k) => `local/dynfx/tex/${k}.webp`)].sort());
  assert.throws(() => sceneFile(d, { tex: (k) => (k === 'c' ? null : tex(k)), mesh }), /texture c/);
  assert.equal(sceneFileName('ab'.repeat(32)), 'scene-abababab.json');
  assert.equal(sceneRel('chars', 'char_c', 'scene-abababab.json'), 'char/dynamic/char_c_2/scene-abababab.json', 'next to the record\'s pictures');
});

test('sceneBatch: the check batches of the trial (battle families only / new L2D ones, parts or skinning / an approximated shader)', () => {
  const { desc: d } = idleScene(desc());
  assert.deepEqual(sceneBatch(d), { batch: 1, families: ['basic'] });
  const parts = structuredClone(d); parts.dyn.spine.separatorSlotNames = ['S'];
  assert.equal(sceneBatch(parts).batch, 2);
  const grab = structuredClone(d); grab.materials[0].shader = 'Torappu/Particles-L2D/Disturb/Disturb GrabPass';
  assert.equal(sceneBatch(grab).batch, 2);
  const toon = structuredClone(d); toon.materials[2].shader = 'Torappu/Particles-L2D/3D/Toon';
  assert.equal(sceneBatch(toon).batch, 3);
});

const sha = (c) => c.repeat(64);
const REG = { version: 1, skins: {
  s_1: { scene: { name: 'scene-aaaaaaaa.json', bytes: 1, sha256: sha('a') }, enabled: true },
  s_2: { scene: { name: 'scene-bbbbbbbb.json', bytes: 9, sha256: sha('b') }, enabled: false },
}, chars: { char_c: { scene: { name: 'scene-cccccccc.json', bytes: 1, sha256: sha('c') }, enabled: true } } };
const dyn = (o = {}) => ({ skel: '/x.skel', atlas: '/x.atlas', textures: ['/x.webp'], ...o });
const body = () => ({ skins: { s_1: { dynamic: dyn() }, s_2: { dynamic: dyn({ scene: '/assets/local/dynfx/scene/old.json' }) }, n: { name: 'n' } },
  chars: { char_c: { dynamicE2: dyn() }, char_d: {} } });

/** An asset tree with the scene files of REG (sizes put into a copy of it) and what they name. */
function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'dynscene-'));
  const reg = structuredClone(REG);
  const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); return Buffer.byteLength(text); };
  const file = (k) => JSON.stringify({ format: 'dyn-scene', textures: { [k]: { path: `/assets/~${'0'.repeat(16)}/local/dynfx/tex/${k}.webp` }, shared: { path: '/assets/local/dynfx/tex/shared.webp' } }, meshes: { m: `/assets/local/dynfx/mesh/${k}.json` } });
  for (const [kind, id, k] of [['skins', 's_1', 'one'], ['chars', 'char_c', 'two']]) {
    reg[kind][id].scene.bytes = put(sceneRel(kind, id, reg[kind][id].scene.name), file(k));
    put(`local/dynfx/tex/${k}.webp`, 'x'.repeat(10)); put(`local/dynfx/mesh/${k}.json`, '{}');
  }
  put('local/dynfx/tex/shared.webp', 'y'.repeat(100));
  return { dir, reg };
}

test('applyDynamicScenes: only enabled records get `scene`; a stale one is dropped; with a tree only scenes whose files are all there', () => {
  const input = body(); const before = JSON.stringify(input);
  const { body: out, records, files } = applyDynamicScenes(input, { registry: REG });
  assert.equal(JSON.stringify(input), before);
  assert.equal(out.skins.s_1.dynamic.scene, '/assets/skins/s_1/dynamic/scene-aaaaaaaa.json');
  assert.equal(out.skins.s_2.dynamic.scene, undefined, 'not checked: the baked pictures only (a scene named before goes)');
  assert.equal(out.chars.char_c.dynamicE2.scene, '/assets/char/dynamic/char_c_2/scene-cccccccc.json');
  assert.deepEqual([out.skins.n, out.chars.char_d], [input.skins.n, input.chars.char_d]);
  assert.equal(records, 2);
  assert.deepEqual([...applyDynamicScenes(input, { registry: REG }).parked], ['skins/s_2/dynamic/scene-bbbbbbbb.json'], 'not checked: kept on disk (fetch-assets --prune)');
  assert.equal(files.size, 0, 'no tree: no file accounting');
  const { dir, reg } = tree();
  try {
    const t = applyDynamicScenes(body(), { registry: reg, assetRoot: dir });
    assert.equal(t.records, 2);
    assert.deepEqual([...t.files.keys()].sort(), ['char/dynamic/char_c_2/scene-cccccccc.json', 'local/dynfx/mesh/one.json', 'local/dynfx/mesh/two.json',
      'local/dynfx/tex/one.webp', 'local/dynfx/tex/shared.webp', 'local/dynfx/tex/two.webp', 'skins/s_1/dynamic/scene-aaaaaaaa.json']);
    rmSync(join(dir, 'local/dynfx/tex/two.webp'));
    const m = applyDynamicScenes(body(), { registry: reg, assetRoot: dir });
    assert.equal(m.body.chars.char_c.dynamicE2.scene, undefined, 'a texture missing: the scene is left out');
    assert.ok(m.body.skins.s_1.dynamic.scene);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prepare-dynamic-scenes: stats move by the files newly named (shared ones once), the hash follows; markChecked is the release list', () => {
  const { dir, reg } = tree();
  try {
    const b = body(); delete b.skins.s_2.dynamic.scene;
    const manifest = { version: 3, hash: contentHash(b), generator: 'tools/fetch-assets.mjs', stats: { files: 10, bytes: 1000 }, ...b };
    const out = rewriteManifest(manifest, { registry: reg, assetRoot: dir });
    const scenes = reg.skins.s_1.scene.bytes + reg.chars.char_c.scene.bytes;
    assert.deepEqual(out.stats, { files: 10 + 7, bytes: 1000 + scenes + 10 + 10 + 2 + 2 + 100 });
    const { version, hash, generator, stats, ...rest } = out;
    assert.equal(hash, contentHash(rest));
    assert.equal(generator, 'tools/fetch-assets.mjs');
    const r2 = structuredClone(reg);
    assert.deepEqual(markChecked(r2, ['skins/s_1'], { on: false }), ['skins/s_1']);
    const back = rewriteManifest(out, { registry: r2, assetRoot: dir });
    assert.equal(back.skins.s_1.dynamic.scene, undefined);
    assert.deepEqual(back.stats, { files: 10 + 4, bytes: 1000 + reg.chars.char_c.scene.bytes + 10 + 2 + 100 }, 'the shared texture stays: char_c names it');
    markChecked(r2, ['skins/s_1'], { note: 'n', date: '2026-11-17' });
    assert.deepEqual([r2.skins.s_1.enabled, r2.skins.s_1.check], [true, { date: '2026-11-17', scene: 'aaaaaaaa', note: 'n' }]);
    assert.throws(() => markChecked(r2, ['skins/nope']), /no scene/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the committed registry: one well-formed scene per 动态立绘 record; data/assets.json names exactly the enabled ones', () => {
  const reg = loadDynamicScenes();
  const manifest = JSON.parse(readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
  for (const [kind, field] of Object.entries(SCENE_FIELDS)) {
    for (const [id, R] of Object.entries(reg[kind] || {})) {
      assert.ok(validSceneEntry(R), `${kind}/${id}`);
      assert.ok(manifest[kind]?.[id]?.[field], `${kind}/${id} is a 动态立绘 record`);
      assert.ok([1, 2, 3].includes(R.batch) && typeof R.enabled === 'boolean', `${kind}/${id}`);
      if (R.enabled) assert.equal(R.check?.scene, R.scene.sha256.slice(0, 8), `${kind}/${id}: checked as it is`);
      const named = manifest[kind][id][field].scene;
      assert.equal(named ?? null, R.enabled ? sceneUrl(kind, id, R.scene.name) : null, `${kind}/${id}`);
    }
    for (const [id, rec] of Object.entries(manifest[kind] || {})) if (rec?.[field]?.scene) assert.ok(reg[kind]?.[id]?.enabled, `${kind}/${id} named but not enabled`);
  }
});
