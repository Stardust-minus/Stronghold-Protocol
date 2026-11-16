// tools/vendor.mjs patchPixiSpine: the fixes of pixi-spine 4.0.6's Spine 3.7 / 3.8 runtimes in the vendored bundle —
// feedback #148 (docs/history/0.3.3.md §36.18): a path constraint in chain / chain-scale rotate mode rotating its bones
// along the path (锏「暗月的影子」's legs), NoRotationOrReflection bones divided by the y-down scale; feedback #168
// (docs/history/0.4.0.md §37.240): the IK of a NoRotationOrReflection / OnlyTranslation bone under y-down, percent path
// spacing under chain scale (缪尔赛思「漫步于黄金之梦」's legs), the NoScale reflection test of a parent scaled to 0.
// Each fix is checked on the minified code of the installed bundle: y-down with mirrored inputs gives what the official
// y-up logic gives. §37.242: the two-colour tint (a slot's dark colour) appended to the bundle, on a stand-in PIXI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installSpineTwoColorTint, patchPixiSpine, TWO_COLOR_MARK, VENDOR_PATCHES } from '../tools/vendor.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'node_modules/pixi-spine/dist/pixi-spine.js');
const SERVED = path.join(ROOT, 'public/vendor/pixi-spine.js');
// the settings object the 3.8 bone reads yDown from, as in the bundle (patchPixiSpine finds its name there)
const BONE_HEAD = 'function updateWorldTransformWith(t){const s=this.parent,a=this.matrix,o=this.skeleton.scaleX,d=zt.yDown?-this.skeleton.scaleY:this.skeleton.scaleY}';

test('the path constraint branch: a chain rotate mode takes the path\'s direction, not 0', () => {
  const src = 'if(b=I,p=V,r){let D=0;if(o&&(o?D=w[T-1]:g[M+1]==0?D=w[T+2]:D=Math.atan2(B,F)),D-=Math.atan2(q,Y),y){X()}}';
  const out = patchPixiSpine(src);
  assert.equal(out.path, 1);
  assert.equal(out.src, 'if(b=I,p=V,r){let D=0;if((o?D=w[T-1]:g[M+1]==0?D=w[T+2]:D=Math.atan2(B,F)),D-=Math.atan2(q,Y),y){X()}}');
  // the same logic as the official runtime: tangents → the stored angle; else a zero space → the next one; else atan2
  const run = (code, o, spaceZero) => {
    const env = { o, w: [0, 0, 0, 7, 0, 0, 9], T: 4, g: [0, spaceZero ? 0 : 5], M: 0, B: 1, F: 1, q: 0, Y: 1, y: false, D: 0, b: 0, p: 0, I: 0, V: 0, r: true, X: () => {} };
    vm.runInNewContext(code.replace('let D=0;', ''), env);
    return env.D;
  };
  assert.equal(run(src, false, false), 0, 'the bug: a chain mode leaves the angle at 0');
  assert.equal(run(out.src, true, false), 7);
  assert.equal(run(out.src, false, true), 9);
  assert.equal(run(out.src, false, false), Math.atan2(1, 1));
});

test('NoRotationOrReflection divides by the function\'s own sx / sy (y-down), not the skeleton\'s scale', () => {
  const src = 'updateWorldTransformWith(t){const s=this.parent,a=this.matrix,o=this.skeleton.scaleX,d=zt.yDown?-this.skeleton.scaleY:this.skeleton.scaleY;'
    + 'switch(1){case j.NoRotationOrReflection:{let x=f*f+m*m,E=0;x>1e-4?(x=Math.abs(f*g-u*m)/x,f/=this.skeleton.scaleX,m/=this.skeleton.scaleY,u=m*x):0;break}}}';
  const out = patchPixiSpine(src);
  assert.equal(out.bone, 1);
  assert.match(out.src, /x=Math\.abs\(f\*g-u\*m\)\/x,f\/=o,m\/=d,u=m\*x/);
  // without the function head to take the names from, nothing changes
  const lone = 'f/=this.skeleton.scaleX,m/=this.skeleton.scaleY';
  assert.deepEqual(patchPixiSpine(lone), { src: lone, path: 0, bone: 0, ik: 0, spacing: 0, noScale: 0, tint: 0 });
});

// IkConstraint.apply1 of the 3.8 runtime, minified as in the bundle: target (n, e), bone t, parent matrix s (a, o, d, f =
// spine's pa, pb, pc, pd), rotation u, local target (m, g)
const IK = 'function apply1(t,n,e){const s=t.parent.matrix,a=s.a;let o=s.c;const d=s.b;let f=s.d,u=-t.ashearX-t.arotation,m=0,g=0;'
  + 'switch(t.data.transformMode){case j.OnlyTranslation:m=n-t.worldX,g=e-t.worldY;break;case j.NoRotationOrReflection:const w=Math.abs(a*f-o*d)/(a*a+d*d),'
  + 'b=a/t.skeleton.scaleX,p=d/t.skeleton.scaleY;o=-p*w*t.skeleton.scaleX,f=b*w*t.skeleton.scaleY,u+=Math.atan2(p,b)*C.radDeg;default:const S=n-s.tx,y=e-s.ty,'
  + 'M=a*f-o*d;m=(S*f-y*o)/M-t.ax,g=(y*a-S*d)/M-t.ay}u+=Math.atan2(g,m)*C.radDeg;return [u,m,g]}';

test('IK of a NoRotationOrReflection / OnlyTranslation bone: y-down with mirrored inputs gives the y-up result', () => {
  const out = patchPixiSpine(BONE_HEAD + IK);
  assert.equal(out.ik, 2);
  const run = (code, yDown, mode) => {
    // the y-up pose: parent basis (pa, pb, pc, pd), parent at (tx, ty), bone at (wx, wy), target (n, e); y-down mirrors y
    const k = yDown ? -1 : 1, P = { a: 0.8, c: -0.3, b: 0.5 * k, d: 0.9 * k, tx: 10, ty: 20 * k };
    const t = { parent: { matrix: P }, ashearX: 0, arotation: 15, ax: 3, ay: -4, worldX: 12, worldY: 18 * k, data: { transformMode: mode }, skeleton: { scaleX: 1, scaleY: 1 } };
    const env = { zt: { yDown }, j: { OnlyTranslation: 1, NoRotationOrReflection: 2 }, C: { radDeg: 180 / Math.PI }, t };
    vm.runInNewContext(`${code};r=apply1(t,40,${60 * k})`, env);
    return Array.from(env.r, (v) => Math.round(v * 1e6) / 1e6); // this realm's array (deepEqual compares prototypes)
  };
  for (const mode of [1, 2]) {
    const up = run(IK, false, mode);
    assert.deepEqual(run(out.src, true, mode), up, `mode ${mode}: y-down = y-up`);
    assert.deepEqual(run(out.src, false, mode), up, `mode ${mode}: y-up unchanged`);
    assert.notDeepEqual(run(IK, true, mode), up, `mode ${mode}: the bug`);
  }
});

// PathConstraint.update's spacing of the 3.8 runtime, minified as in the bundle (vt = SpacingMode, pt = RotateMode)
const SPACING = 'function spaces(){const h=this.data,l=h.spacingMode,s=l==vt.Length,a=h.rotateMode,o=a==pt.Tangent,d=a==pt.ChainScale,f=this.bones.length,u=o?f:f+1,'
  + 'm=this.bones,g=v.setArraySize(this.spaces,u);let x=null;const E=this.spacing;if(d||s){d&&(x=v.setArraySize(this.lengths,f));for(let M=0,T=u-1;M<T;){'
  + 'const k=m[M],R=k.data.length;if(R<nn.epsilon)d&&(x[M]=0),g[++M]=0;else{const I=R*k.matrix.a,V=R*k.matrix.b,F=Math.sqrt(I*I+V*V);d&&(x[M]=F),'
  + 'g[++M]=(s?R+E:E)*F/R}}}else for(let M=1;M<u;M++)g[M]=E;return [g.slice(1),x]}';

test('path spacing: percent stays the percent under chain scale; fixed and length scale by the bone (the official)', () => {
  const out = patchPixiSpine(SPACING);
  assert.equal(out.spacing, 1);
  const run = (code, spacingMode, rotateMode) => {
    // two bones of setup length 10, drawn twice as long; spacing 0.25
    const self = { data: { spacingMode, rotateMode }, bones: [0, 1].map(() => ({ data: { length: 10 }, matrix: { a: 2, b: 0 } })), spaces: [], lengths: [], spacing: 0.25 };
    const env = { vt: { Length: 0, Fixed: 1, Percent: 2 }, pt: { Tangent: 0, Chain: 1, ChainScale: 2 }, v: { setArraySize: (a, n) => { a.length = n; return a; } }, nn: { epsilon: 1e-5 }, self };
    vm.runInNewContext(`${code};r=spaces.call(self)`, env);
    return JSON.parse(JSON.stringify(env.r));
  };
  // the official 3.8 (spine-ts / spine-csharp branch 3.8): percent → the spacing, lengths measured under chain scale;
  // fixed → spacing × world / setup length; length → (setup + spacing) × world / setup
  assert.deepEqual(run(out.src, 2, 2), [[0.25, 0.25], [20, 20]]);
  assert.deepEqual(run(out.src, 2, 1), [[0.25, 0.25], null]);
  assert.deepEqual(run(out.src, 1, 1), [[0.5, 0.5], null]);
  assert.deepEqual(run(out.src, 1, 2), [[0.5, 0.5], [20, 20]]);
  assert.deepEqual(run(out.src, 0, 1), [[20.5, 20.5], null]);
  assert.deepEqual(run(SPACING, 2, 2), [[0.5, 0.5], [20, 20]], 'the bug: percent scaled by the bone under chain scale');
});

test('NoScale: the reflection test mirrors the determinant, so a parent scaled to 0 does not flip the child', () => {
  const NS = `${BONE_HEAD};function noScale(){let p=1;this.data.transformMode==j.NoScale&&f*g-u*m<0!=(zt.yDown?this.skeleton.scaleX<0!=this.skeleton.scaleY>0:`
    + 'this.skeleton.scaleX<0!=this.skeleton.scaleY<0)&&(p=-p);return p}';
  const out = patchPixiSpine(NS);
  assert.equal(out.noScale, 1);
  const run = (code, yDown, det) => {
    // y-up parent basis with this determinant (f·g − u·m); y-down negates its second row, and with it the determinant
    const self = { data: { transformMode: 3 }, skeleton: { scaleX: 1, scaleY: 1 } };
    const env = { zt: { yDown }, j: { NoScale: 3 }, f: 1, g: yDown ? -det : det, u: 0, m: 0, self };
    vm.runInNewContext(`${code};r=noScale.call(self)`, env);
    return env.r;
  };
  for (const det of [-1, 0, 1]) {
    const up = run(NS, false, det);
    assert.equal(up, det < 0 ? -1 : 1, `det ${det}: the y-up test`);
    assert.equal(run(out.src, true, det), up, `det ${det}: y-down = y-up`);
    assert.equal(run(out.src, false, det), up, `det ${det}: y-up unchanged`);
  }
  assert.equal(run(NS, true, 0), -1, 'the bug: det 0 flips under y-down');
});

test('the installed pixi-spine bundle gets every fix, still parses, and patching twice changes nothing', { skip: !existsSync(DIST) && 'pixi-spine not installed' }, () => {
  const src = readFileSync(DIST, 'utf8');
  const out = patchPixiSpine(src);
  // 4.0.6 (package-lock.json): the 3.7 and 3.8 path constraints, the 3.8 bone, the 3.8 IK (two branches), the 3.7 and 3.8
  // path spacing and NoScale test; its 4.1 runtime has the first two fixes already; the two-colour tint once
  assert.deepEqual({ path: out.path, bone: out.bone, ik: out.ik, spacing: out.spacing, noScale: out.noScale, tint: out.tint }, { path: 2, bone: 1, ik: 2, spacing: 2, noScale: 2, tint: 1 });
  assert.doesNotThrow(() => new vm.Script(out.src, { filename: 'pixi-spine.js' }));
  assert.doesNotMatch(out.src, /if\((\w+)&&\(\1\?\w+=\w+\[\w+-1\]:/);
  assert.doesNotMatch(out.src, /\/=this\.skeleton\.scaleX,\w+\/=this\.skeleton\.scaleY/);
  assert.doesNotMatch(out.src, /\w+=\w+\/\w+\.skeleton\.scaleY;/);
  assert.doesNotMatch(out.src, /yDown\?this\.skeleton\.scaleX<0!=this\.skeleton\.scaleY>0/);
  // the installer runs after the bundle (its own `this.PIXI`), the source map comment stays last
  assert.equal(out.src.split(TWO_COLOR_MARK).length, 2);
  assert.ok(out.src.indexOf(TWO_COLOR_MARK) > out.src.indexOf('tt.SpineBase=') && out.src.trimEnd().endsWith('//# sourceMappingURL=pixi-spine.js.map'));
  const again = patchPixiSpine(out.src);
  assert.deepEqual([again.path, again.bone, again.ik, again.spacing, again.noScale, again.tint, again.src === out.src], [0, 0, 0, 0, 0, 0, true]);
  assert.equal(VENDOR_PATCHES['pixi-spine.js'](src), out.src);
});

// A stand-in for what installSpineTwoColorTint uses of PIXI 7.4.2 and pixi-spine 4.0.6's SpineBase: the factories
// (createSprite → newSprite, createMesh → newMesh); its update (which sets the light colour as `tint`) is left alone.
function standIn() {
  const shared = { v: 0, setValue(v) { this.v = v; return this; },
    // PIXI.Color#toPremultiplied of a little-endian tint (bytes r, g, b, a in memory)
    toPremultiplied(a, rgb) { const ch = (s) => { const c = (this.v >> s) & 255; return rgb ? (c * a + 0.5) | 0 : c; }; return ((a * 255) << 24 | ch(16) << 16 | ch(8) << 8 | ch(0)) >>> 0; } };
  class Geometry { constructor() { this.attributes = []; } addAttribute(name) { this.attributes.push(name); return this; } addIndex() { return this; } }
  class BatchRenderer { constructor(renderer) { this.renderer = renderer; this.contextChanged = 0; } setShaderGenerator(o) { this.generator = o; } contextChange() { this.contextChanged++; } }
  class MeshMaterial {
    constructor(texture, o = {}) { this.uniforms = { uSampler: texture, uColor: new Float32Array(4), ...o.uniforms }; this.program = o.program; this.batchable = !o.program; this.pluginName = 'batch'; this._alpha = 1; }
    get texture() { return this.uniforms.uSampler; }
    update() {}
  }
  class Sprite { constructor(texture) { this.texture = texture; this.pluginName = 'batch'; } _render(renderer) { renderer.drawn.push([this.pluginName, this]); } }
  class SpineSprite extends Sprite {}
  class SpineMesh { constructor(texture) { this.shader = new MeshMaterial(texture); } _render(renderer) { renderer.drawn.push([this.shader.pluginName, this]); } }
  class SpineBase {
    constructor(slots) { this.skeleton = { slots }; for (const slot of slots) if (slot.mesh) slot.currentMesh = this.createMesh(slot, {}); else slot.currentSprite = this.createSprite(slot, {}, slot.name); }
    createSprite(slot, attachment, name) { return this.newSprite(`tex:${name}`); }
    createMesh() { return this.newMesh('tex:mesh', null, null, null, 4); }
    newSprite(texture) { return new SpineSprite(texture); }
    newMesh(texture) { return new SpineMesh(texture); }
    update() {}
  }
  return { Buffer: class {}, Color: { shared }, Geometry, TYPES: { FLOAT: 5126, UNSIGNED_BYTE: 5121 }, BatchRenderer, MeshMaterial,
    Program: { from: (v, f, name) => ({ v, f, name }) }, spine: { SpineBase, SpineSprite, SpineMesh } };
}

test('two-colour tint: the attachments of slots with a dark colour draw through it, the rest as before', () => {
  const PIXI = standIn();
  const update = PIXI.spine.SpineBase.prototype.update;
  assert.equal(installSpineTwoColorTint(PIXI), true);
  assert.equal(installSpineTwoColorTint(PIXI), false, 'once');
  assert.equal(PIXI.spine.SpineBase.prototype.update, update, 'nothing added to the update');
  const color = (r, g, b) => ({ r, g, b, a: 1 });
  const slots = [{ name: 'plain', darkColor: null }, { name: 'dark', darkColor: color(0.2, 0.4, 0.6) }, { name: 'darkMesh', mesh: true, darkColor: color(1, 0, 0.5) }, { name: 'plainMesh', mesh: true, darkColor: null }];
  new PIXI.spine.SpineBase(slots);
  const [plain, dark, darkMesh, plainMesh] = slots;
  assert.ok(!(plain.currentSprite instanceof PIXI.spine.TwoColorSprite) && plain.currentSprite.pluginName === 'batch' && !('darkColor' in plain.currentSprite));
  assert.ok(dark.currentSprite instanceof PIXI.spine.TwoColorSprite && dark.currentSprite instanceof PIXI.spine.SpineSprite);
  assert.equal(dark.currentSprite.pluginName, 'spineTwoColorBatch');
  // the slot's own dark colour object: what an animation keys into it is what the next draw reads
  assert.equal(dark.currentSprite.darkColor, dark.darkColor);
  const mesh = darkMesh.currentMesh;
  assert.ok(mesh instanceof PIXI.spine.TwoColorMesh && mesh.shader instanceof PIXI.spine.TwoColorMeshMaterial);
  assert.ok(mesh.shader.batchable && mesh.shader.pluginName === 'spineTwoColorBatch' && mesh.shader.uniforms.uSampler === 'tex:mesh');
  assert.ok(mesh.darkColor === darkMesh.darkColor && mesh.shader.darkColor === darkMesh.darkColor);
  assert.ok(!(plainMesh.currentMesh instanceof PIXI.spine.TwoColorMesh) && plainMesh.currentMesh.shader.pluginName === 'batch');
  // the renderer's batch plugin is made on its first two-colour draw (context ready: contextChange)
  const renderer = { plugins: {}, gl: {}, drawn: [] };
  plain.currentSprite._render(renderer);
  assert.deepEqual(Object.keys(renderer.plugins), []);
  dark.currentSprite._render(renderer); mesh._render(renderer);
  const batch = renderer.plugins.spineTwoColorBatch;
  assert.ok(batch instanceof PIXI.BatchRenderer && batch.contextChanged === 1 && batch.vertexSize === 7);
  assert.deepEqual(batch.geometryClass.prototype instanceof PIXI.Geometry && new batch.geometryClass().attributes, ['aVertexPosition', 'aTextureCoord', 'aColor', 'aDarkColor', 'aTextureId']);
  assert.deepEqual(renderer.drawn.map(([p]) => p), ['batch', 'spineTwoColorBatch', 'spineTwoColorBatch']);
});

test('two-colour tint: the dark colour per vertex and as a uniform, premultiplied or straight, as spine-webgl', () => {
  const PIXI = standIn();
  installSpineTwoColorTint(PIXI);
  const batch = new PIXI.spine.TwoColorBatchRenderer({});
  // spine-webgl's two-colour fragment, word for word but the names
  const official = '((texColor.a - 1.0) * v_dark.a + 1.0 - texColor.rgb) * v_dark.rgb + texColor.rgb * v_light.rgb';
  assert.ok(batch.generator.fragment.includes(official.replace(/texColor/g, 'color').replace(/v_dark/g, 'vDark').replace(/v_light/g, 'vColor')));
  const mat = new PIXI.spine.TwoColorMeshMaterial({ baseTexture: { alphaMode: 2 } });
  assert.ok(mat.program.f.includes(official.replace(/texColor/g, 'color').replace(/v_dark/g, 'uDark').replace(/v_light/g, 'uColor')));
  // pack one vertex: light tint (little-endian 0xBBGGRR) 0x336699 · alpha 0.5, dark (0.2, 0.4, 1)
  const pack = (alphaMode) => {
    // after one vertex already packed (aIndex 7, iIndex 1)
    const buf = new ArrayBuffer(14 * 4), f = new Float32Array(buf), u = new Uint32Array(buf), idx = new Uint16Array(3);
    const el = { uvs: [0.25, 0.75], indices: [0], vertexData: [10, 20], worldAlpha: 0.5, _tintRGB: 0x336699, darkColor: { r: 0.2, g: 0.4, b: 1, a: 1 }, _texture: { baseTexture: { alphaMode, _batchLocation: 3 } } };
    batch.packInterleavedGeometry(el, { float32View: f, uint32View: u }, idx, 7, 1);
    const bytes = (x) => [x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24];
    return { f: [f[7], f[8], f[9], f[10], f[13]], light: bytes(u[11]), dark: bytes(u[12]), index: idx[1] };
  };
  const pm = pack(2);
  assert.deepEqual(pm.f, [10, 20, 0.25, 0.75, 3]);
  assert.equal(pm.index, 1, 'indices offset by the vertices already packed');
  assert.deepEqual(pm.light, [0x4d, 0x33, 0x1a, 127], 'the light colour as PIXI.BatchRenderer packs it');
  assert.deepEqual(pm.dark, [26, 51, 128, 255], 'premultiplied: dark × alpha, a = 1');
  assert.deepEqual(pack(0).dark, [51, 102, 255, 0], 'straight: dark as it is, a = 0');
  mat.update();
  assert.deepEqual([...mat.uniforms.uDark], [0, 0, 0, 1], 'no dark colour: black');
  mat.darkColor = { r: 0.2, g: 0.4, b: 1, a: 1 }; mat._alpha = 0.5; mat.update();
  assert.deepEqual([...mat.uniforms.uDark], [0.1, 0.2, 0.5, 1].map(Math.fround));
  mat.uniforms.uSampler = { baseTexture: { alphaMode: 0 } }; mat.update();
  assert.deepEqual([...mat.uniforms.uDark], [0.2, 0.4, 1, 0].map(Math.fround));
});

test('two-colour tint: a straight page in spine-webgl and the premultiplied page Pixi uploads give one picture', () => {
  // spine-webgl, straight page (premultipliedAlpha false): out = shader(t), blended SRC_ALPHA, ONE_MINUS_SRC_ALPHA;
  // Pixi: the page premultiplied (T = t.rgb · t.a), light / dark × alpha, a = 1, blended ONE, ONE_MINUS_SRC_ALPHA
  const shade = (tex, light, dark) => [0, 1, 2].map((c) => ((tex[3] - 1) * dark[3] + 1 - tex[c]) * dark[c] + tex[c] * light[c]).concat(tex[3] * light[3]);
  const cases = [[[0.9, 0.3, 0.1, 0.6], [0.8, 0.5, 1, 0.7], [0.3, 0.6, 0.2]], [[0.2, 0.8, 0.5, 1], [1, 1, 1, 1], [0, 0, 0]], [[0.5, 0.5, 0.5, 0.05], [0.1, 0.9, 0.4, 0.3], [1, 1, 1]]];
  for (const [t, light, dark] of cases) for (const bg of [[0, 0, 0], [1, 1, 1], [0.2, 0.7, 0.4]]) {
    const s = shade(t, light, [...dark, 0]);
    const straight = bg.map((b, c) => s[c] * s[3] + b * (1 - s[3]));
    const T = [t[0] * t[3], t[1] * t[3], t[2] * t[3], t[3]], a = light[3];
    const p = shade(T, [light[0] * a, light[1] * a, light[2] * a, a], [dark[0] * a, dark[1] * a, dark[2] * a, 1]);
    const premultiplied = bg.map((b, c) => p[c] + b * (1 - p[3]));
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(straight[c] - premultiplied[c]) < 1e-12, `${JSON.stringify([t, light, dark, bg])} channel ${c}`);
  }
});

test('public/vendor/pixi-spine.js is the patched bundle (npm run vendor)', { skip: !(existsSync(DIST) && existsSync(SERVED)) && 'not vendored' }, () => {
  assert.equal(readFileSync(SERVED, 'utf8'), patchPixiSpine(readFileSync(DIST, 'utf8')).src, 'public/vendor/pixi-spine.js is stale: run npm run vendor');
});
