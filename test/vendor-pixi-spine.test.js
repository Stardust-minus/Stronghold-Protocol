// tools/vendor.mjs patchPixiSpine: the fixes of pixi-spine 4.0.6's Spine 3.7 / 3.8 runtimes in the vendored bundle —
// feedback #148 (docs/history/0.3.3.md §36.18): a path constraint in chain / chain-scale rotate mode rotating its bones
// along the path (锏「暗月的影子」's legs), NoRotationOrReflection bones divided by the y-down scale; feedback #168
// (docs/history/0.4.0.md §37.240): the IK of a NoRotationOrReflection / OnlyTranslation bone under y-down, percent path
// spacing under chain scale (缪尔赛思「漫步于黄金之梦」's legs), the NoScale reflection test of a parent scaled to 0.
// Each fix is checked on the minified code of the installed bundle: y-down with mirrored inputs gives what the official
// y-up logic gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { patchPixiSpine, VENDOR_PATCHES } from '../tools/vendor.mjs';

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
  assert.deepEqual(patchPixiSpine(lone), { src: lone, path: 0, bone: 0, ik: 0, spacing: 0, noScale: 0 });
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
  // path spacing and NoScale test; its 4.1 runtime has the first two fixes already
  assert.deepEqual({ path: out.path, bone: out.bone, ik: out.ik, spacing: out.spacing, noScale: out.noScale }, { path: 2, bone: 1, ik: 2, spacing: 2, noScale: 2 });
  assert.doesNotThrow(() => new vm.Script(out.src, { filename: 'pixi-spine.js' }));
  assert.doesNotMatch(out.src, /if\((\w+)&&\(\1\?\w+=\w+\[\w+-1\]:/);
  assert.doesNotMatch(out.src, /\/=this\.skeleton\.scaleX,\w+\/=this\.skeleton\.scaleY/);
  assert.doesNotMatch(out.src, /\w+=\w+\/\w+\.skeleton\.scaleY;/);
  assert.doesNotMatch(out.src, /yDown\?this\.skeleton\.scaleX<0!=this\.skeleton\.scaleY>0/);
  const again = patchPixiSpine(out.src);
  assert.deepEqual([again.path, again.bone, again.ik, again.spacing, again.noScale, again.src === out.src], [0, 0, 0, 0, 0, true]);
  assert.equal(VENDOR_PATCHES['pixi-spine.js'](src), out.src);
});

test('public/vendor/pixi-spine.js is the patched bundle (npm run vendor)', { skip: !(existsSync(DIST) && existsSync(SERVED)) && 'not vendored' }, () => {
  assert.equal(readFileSync(SERVED, 'utf8'), patchPixiSpine(readFileSync(DIST, 'utf8')).src, 'public/vendor/pixi-spine.js is stale: run npm run vendor');
});
