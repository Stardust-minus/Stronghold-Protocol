// Copies client vendor libraries from node_modules into public/vendor (run by `npm run vendor` / postinstall).
//
// three.js (the official 3D board scene, DESIGN §15) ships as two ES modules: three.module.js imports
// './three.core.js', so both are copied side by side and the renderer imports '/vendor/three.module.js' directly
// (no import map, no CDN — LAN play works offline). Optional packages that are not installed are skipped with a
// warning instead of failing the install.
// Preact's hooks build imports the bare specifier "preact"; it is rewritten to the sibling './preact.module.js' (the
// same URL the import map resolves "preact" to, so one Preact instance) — module graphs then load without import-map
// support (Safari < 16.4).
// pixi-spine 4.0.6's bundle gets fixes of its Spine 3.7 / 3.8 runtimes (patchPixiSpine): two for feedback #148 (锏「暗月的影子」:
// the legs of the 动态立绘 stood at the wrong angles), three more for feedback #168 (引星棘刺「无际之帆」's right shoulder,
// 缪尔赛思「漫步于黄金之梦」's legs). Its 4.1 runtime has the first two already; the bundle runs every 4.x model on it.
// It also gets the two-colour tint (a slot's dark colour, the editor's "tint black") that pixi-spine does not draw
// (installSpineTwoColorTint, appended: 塔露拉's dragon in 互动 came out red, history §37.242).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');

/** Bare specifiers inside vendored ES modules → their sibling vendored file. */
export const VENDOR_REWRITES = Object.freeze({ 'hooks.module.js': { preact: './preact.module.js' } });

/**
 * Rewrite `from"x"` / `from 'x'` / `import("x")` of the mapped bare specifiers in a vendored module source.
 * @param {string} src
 * @param {Record<string, string>} map
 */
export function rewriteBare(src, map) {
  let res = src;
  for (const [bare, rel] of Object.entries(map)) {
    const esc = bare.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    res = res.replace(new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s*)(["'])${esc}\\2`, 'g'), (_, pre, q) => `${pre}${q}${rel}${q}`);
  }
  return res;
}

/**
 * Bugs of pixi-spine 4.0.6's Spine 3.7 / 3.8 runtimes, fixed in the vendored bundle. Checked against the official spine-ts
 * 3.8 runtime (EsotericSoftware/spine-runtimes, branch 3.8), drawn display list against official draw order, vertex by
 * vertex, every animation. Feedback #148 (docs/history/0.3.3.md §36.18):
 *   - PathConstraint.update: `if (tangents) if (tangents) r = …; else if (spaces[i + 1] == 0) r = …; else r = atan2(…)`
 *     — the doubled `if` leaves r = 0 for a constraint whose rotate mode is chain or chain scale, so every bone it
 *     rotates snaps to world angle 0 (the official: `if (tangents) … else if … else …`). Minified:
 *     `if(o&&(o?D=w[T-1]:g[M+1]==0?D=w[T+2]:D=Math.atan2(B,F)),…` → `if((o?D=w[T-1]:…),…`.
 *   - Bone.updateWorldTransformWith, NoRotationOrReflection (3.8): the parent's basis is divided by the skeleton's own
 *     scaleX / scaleY, but pixi-spine draws y-down by negating scaleY in that function (`sy`), not in the skeleton, so
 *     these bones (hair strands, ribbons) came out mirrored a little. Divide by the function's sx / sy, as pixi-spine's
 *     own 4.0 / 4.1 runtimes do: `f/=this.skeleton.scaleX,m/=this.skeleton.scaleY` → `f/=o,m/=d`.
 * Feedback #168 (docs/history/0.4.0.md §37.240) — after the two above, 18 of the 71 动态立绘 on hand were still off by
 * more than 2.5 units:
 *   - IkConstraint.apply1 (3.8), the same y-down slip twice: a NoRotationOrReflection bone's parent basis is divided and
 *     rebuilt with the skeleton's scaleY, not the y-down one (`ik`, 引星棘刺「无际之帆」's shoulder and arm: up to 82
 *     units), and an OnlyTranslation bone aims at the target with the y-down offset un-flipped (`ik`, 遥「常世之幻」,
 *     焰影苇草「夏卉 FA075」, 纯烬艾雅法拉「后来的故事」: up to 239).
 *     `b=a/t.skeleton.scaleX,p=d/t.skeleton.scaleY;o=…*t.skeleton.scaleX,f=…*t.skeleton.scaleY` takes
 *     `(zt.yDown?-t.skeleton.scaleY:t.skeleton.scaleY)`; `g=e-t.worldY` → `g=zt.yDown?t.worldY-e:e-t.worldY` (pixi-spine's
 *     4.0 runtime flips it the same way).
 *   - PathConstraint.update (3.7 / 3.8), percent spacing under chain scale (`spacing`): the official keeps the percent as
 *     is and only measures the bones' lengths for the scale; pixi-spine scales it by each bone's world length / setup
 *     length like a fixed spacing (缪尔赛思「漫步于黄金之梦」's right leg in Interact: 21; 缄默德克萨斯「破翼者」's left
 *     leg: 190). `if(d||s){…g[++M]=(s?R+E:E)*F/R}}}else` → `if(d||l!=vt.Percent){…g[++M]=l==vt.Percent?E:(s?R+E:E)*F/R}}}else`.
 *   - Bone.updateWorldTransformWith, NoScale (3.7 / 3.8), the reflection test (`noScale`): `det < 0 != (yDown ?
 *     scaleX < 0 != scaleY > 0 : …)` is the y-up test mirrored except at det = 0 — a parent scaled to 0 flips the NoScale
 *     child, which the y-up runtime leaves alone (酒神「真我自扼」's hair under a control bone scaled to 0: 6). Mirror the
 *     determinant instead: `(zt.yDown?-(f*g-u*m):f*g-u*m)<0!=(this.skeleton.scaleX<0!=this.skeleton.scaleY<0)`.
 * With all of them the 71 agree within 0.5 units in every clip, and 18 of the 1018 battle skeletons on hand move, all
 * towards the official.
 * Two-colour tint (`tint`, history §37.242): pixi-spine 4.x draws a slot's light colour only and drops its dark colour,
 * so a slot keyed to a dark colour (塔露拉's 精二 dragon in 互动; 21 动态立绘 and 12 battle models on hand) came out in
 * the wrong colours. installSpineTwoColorTint (below) is appended once, after the bundle, and draws such slots with
 * spine-webgl's two-colour shader.
 * Returns the patched source and how many of each were applied; the bundle of the version in package-lock.json has
 * path 2, bone 1, ik 2, spacing 2, noScale 2, tint 1 (test/vendor-pixi-spine.test.js). A bundle without them (another
 * pixi-spine version) is returned unchanged; patching twice changes nothing.
 * @param {string} src
 * @returns {{ src: string, path: number, bone: number, ik: number, spacing: number, noScale: number, tint: number }}
 */
export function patchPixiSpine(src) {
  let path = 0;
  let out = src.replace(/if\((\w+)&&\(\1\?(\w+)=(\w+)\[(\w+)-1\]:/g, (_, t, r, positions, p) => { path++; return `if((${t}?${r}=${positions}[${p}-1]:`; });
  let bone = 0;
  const NRR = /(\w+)\/=this\.skeleton\.scaleX,(\w+)\/=this\.skeleton\.scaleY/g;
  out = out.replace(NRR, (whole, pa, pc, at) => {
    // the function's own sx / sy: `o=this.skeleton.scaleX,d=zt.yDown?-this.skeleton.scaleY:this.skeleton.scaleY` before it
    const head = out.slice(Math.max(0, at - 2000), at);
    const m = [...head.matchAll(/(\w+)=this\.skeleton\.scaleX,(\w+)=\w+\.yDown\?-this\.skeleton\.scaleY:this\.skeleton\.scaleY/g)].pop();
    if (!m) return whole;
    bone++;
    return `${pa}/=${m[1]},${pc}/=${m[2]}`;
  });
  // pixi-spine's settings object (`zt.yDown`), as the 3.7 / 3.8 bones read it
  const settings = /(\w+)\.yDown\?-this\.skeleton\.scaleY/.exec(out)?.[1];
  let ik = 0, spacing = 0, noScale = 0;
  if (settings) {
    out = out.replace(/(\w+)=(\w+)\/(\w+)\.skeleton\.scaleX,(\w+)=(\w+)\/\3\.skeleton\.scaleY;(\w+)=-\4\*(\w+)\*\3\.skeleton\.scaleX,(\w+)=\1\*\7\*\3\.skeleton\.scaleY/g,
      (_, sa, pa, t, sc, pc, pb, s, pd) => {
        ik++;
        const sy = `(${settings}.yDown?-${t}.skeleton.scaleY:${t}.skeleton.scaleY)`;
        return `${sa}=${pa}/${t}.skeleton.scaleX,${sc}=${pc}/${sy};${pb}=-${sc}*${s}*${t}.skeleton.scaleX,${pd}=${sa}*${s}*${sy}`;
      });
    out = out.replace(/case (\w+)\.OnlyTranslation:(\w+)=(\w+)-(\w+)\.worldX,(\w+)=(\w+)-\4\.worldY;break;case \1\.NoRotationOrReflection:const/g,
      (_, mode, tx, x, b, ty, y) => { ik++; return `case ${mode}.OnlyTranslation:${tx}=${x}-${b}.worldX,${ty}=${settings}.yDown?${b}.worldY-${y}:${y}-${b}.worldY;break;case ${mode}.NoRotationOrReflection:const`; });
    out = out.replace(/(\w+)\*(\w+)-(\w+)\*(\w+)<0!=\((\w+)\.yDown\?this\.skeleton\.scaleX<0!=this\.skeleton\.scaleY>0:this\.skeleton\.scaleX<0!=this\.skeleton\.scaleY<0\)/g,
      (_, a, d, b, c, yDown) => { noScale++; const det = `${a}*${d}-${b}*${c}`; return `(${yDown}.yDown?-(${det}):${det})<0!=(this.skeleton.scaleX<0!=this.skeleton.scaleY<0)`; });
  }
  out = out.replace(/(\w+)=(\w+)\.spacingMode,(\w+)=\1==(\w+)\.Length,([^]{0,200}?)if\((\w+)\|\|\3\)\{([^]{0,400}?)(\w+)\[\+\+(\w+)\]=\(\3\?(\w+)\+(\w+):\11\)\*(\w+)\/\10\}\}\}else/g,
    (_, mode, data, length, kinds, mid, scale, loop, spaces, i, setup, value, world) => {
      spacing++;
      return `${mode}=${data}.spacingMode,${length}=${mode}==${kinds}.Length,${mid}if(${scale}||${mode}!=${kinds}.Percent){${loop}`
        + `${spaces}[++${i}]=${mode}==${kinds}.Percent?${value}:(${length}?${setup}+${value}:${value})*${world}/${setup}}}}else`;
    });
  // the two-colour tint: once, into a bundle that exports SpineBase with the attachment factories it hooks
  let tint = 0;
  if (!out.includes(TWO_COLOR_MARK) && /\.SpineBase=\w+/.test(out) && /\bcreateSprite\(\w+,\w+,\w+\)\{/.test(out)
    && /\bnewMesh\(\w+,\w+,\w+,\w+,\w+\)\{/.test(out)) {
    tint++;
    const block = `\n${TWO_COLOR_MARK}\n;(${installSpineTwoColorTint})(this.PIXI);`;
    const map = out.lastIndexOf('\n//# sourceMappingURL=');
    out = map >= 0 ? out.slice(0, map) + block + out.slice(map) : `${out}${block}\n`;
  }
  return { src: out, path, bone, ik, spacing, noScale, tint };
}

/** The first line of the two-colour tint patchPixiSpine appends to the pixi-spine bundle. */
export const TWO_COLOR_MARK = '/* Stronghold: Spine two-colour tint (tools/vendor.mjs installSpineTwoColorTint) */';

/**
 * Two-colour tint for pixi-spine 4.x (whose SpineBase draws a slot's light colour only). Appended to the vendored bundle
 * by patchPixiSpine and run there once with the page's PIXI; its source is the bundle's, so it uses nothing but `PIXI`.
 * What it draws is spine-ts' two-colour pipeline (spine-webgl 3.8 / 4.x SkeletonRenderer.draw + Shader.newTwoColoredTextured):
 *   light = skeleton × slot × attachment colour; dark = the slot's dark colour (not multiplied by the skeleton's);
 *   premultiplied alpha: light.rgb × light.a, dark.rgb × light.a, dark.a = 1; straight alpha: dark.a = 0;
 *   out.a = tex.a × light.a,  out.rgb = ((tex.a − 1) × dark.a + 1 − tex.rgb) × dark.rgb + tex.rgb × light.rgb.
 * Pixi keeps every page premultiplied on the GPU (a PMA page as it is, a straight one premultiplied on upload or by
 * createImageBitmap, alphaMode > 0) and blends it as premultiplied, so the premultiplied form applies — spine-webgl's
 * straight form, with its source-alpha blending multiplied out, is the same picture: tex.a·((1 − t)·dark + t·light)·light.a
 * = (tex.a − T)·dark·light.a + T·light·light.a for the premultiplied T = tex.a·t. A page Pixi keeps straight
 * (alphaMode 0, blended straight) takes the straight form.
 * Only slots with a dark colour (Slot.darkColor, set by the editor's "tint black") change: their attachments become
 * TwoColorSprite / TwoColorMesh, drawn by a batch renderer whose vertices carry the dark colour (plugin
 * `spineTwoColorBatch`), or — a mesh too large to batch — by a mesh material with it as a uniform. A black dark colour
 * draws exactly the plain tint; other slots and skeletons without such a slot are drawn as before, pixel for pixel.
 * Returns false when this PIXI has no pixi-spine 4 to extend, or it is extended already.
 * @param {any} PIXI
 */
export function installSpineTwoColorTint(PIXI) {
  const S = PIXI && PIXI.spine;
  if (!S || !S.SpineBase || !S.SpineSprite || !S.SpineMesh || !PIXI.BatchRenderer || !PIXI.MeshMaterial || S.SpineBase.twoColorTint) return false;
  const NAME = 'spineTwoColorBatch';
  // PIXI.BatchRenderer's default shader, plus the dark colour per vertex and spine-webgl's two-colour fragment
  const BATCH_VERTEX = `precision highp float;
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
attribute vec4 aColor;
attribute vec4 aDarkColor;
attribute float aTextureId;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec4 tint;

varying vec2 vTextureCoord;
varying vec4 vColor;
varying vec4 vDark;
varying float vTextureId;

void main(void){
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = aTextureCoord;
    vTextureId = aTextureId;
    vColor = aColor * tint;
    vDark = aDarkColor;
}
`;
  const BATCH_FRAGMENT = `varying vec2 vTextureCoord;
varying vec4 vColor;
varying vec4 vDark;
varying float vTextureId;
uniform sampler2D uSamplers[%count%];

void main(void){
    vec4 color;
    %forloop%
    gl_FragColor.a = color.a * vColor.a;
    gl_FragColor.rgb = ((color.a - 1.0) * vDark.a + 1.0 - color.rgb) * vDark.rgb + color.rgb * vColor.rgb;
}
`;
  // PIXI.MeshMaterial's shader with the dark colour as a uniform (a mesh drawn on its own)
  const MESH_VERTEX = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform mat3 uTextureMatrix;

varying vec2 vTextureCoord;

void main(void)
{
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = (uTextureMatrix * vec3(aTextureCoord, 1.0)).xy;
}
`;
  const MESH_FRAGMENT = `varying vec2 vTextureCoord;
uniform vec4 uColor;
uniform vec4 uDark;

uniform sampler2D uSampler;

void main(void)
{
    vec4 color = texture2D(uSampler, vTextureCoord);
    gl_FragColor.a = color.a * uColor.a;
    gl_FragColor.rgb = ((color.a - 1.0) * uDark.a + 1.0 - color.rgb) * uDark.rgb + color.rgb * uColor.rgb;
}
`;
  const { Buffer, Color, Geometry, TYPES } = PIXI;
  const byte = (v) => (v > 0 ? (v < 1 ? (v * 255 + 0.5) | 0 : 255) : 0);
  /** A vertex's dark colour, RGBA bytes: rgb × alpha and a = 1 on a premultiplied page, rgb and a = 0 on a straight one. */
  const packDark = (d, alpha, premultiplied) => {
    const k = premultiplied ? alpha : 1;
    return ((premultiplied ? 255 : 0) << 24 | (d ? byte(d.b * k) << 16 | byte(d.g * k) << 8 | byte(d.r * k) : 0)) >>> 0;
  };
  /** PIXI.BatchGeometry with aDarkColor after aColor. */
  class TwoColorGeometry extends Geometry {
    constructor(_static = false) {
      super();
      this._buffer = new Buffer(null, _static, false);
      this._indexBuffer = new Buffer(null, _static, true);
      this.addAttribute('aVertexPosition', this._buffer, 2, false, TYPES.FLOAT)
        .addAttribute('aTextureCoord', this._buffer, 2, false, TYPES.FLOAT)
        .addAttribute('aColor', this._buffer, 4, true, TYPES.UNSIGNED_BYTE)
        .addAttribute('aDarkColor', this._buffer, 4, true, TYPES.UNSIGNED_BYTE)
        .addAttribute('aTextureId', this._buffer, 1, true, TYPES.FLOAT)
        .addIndex(this._indexBuffer);
    }
  }
  /** The batch of two-colour sprites and small meshes: PIXI.BatchRenderer with the dark colour beside the light one. */
  class TwoColorBatchRenderer extends PIXI.BatchRenderer {
    constructor(renderer) {
      super(renderer);
      this.setShaderGenerator({ vertex: BATCH_VERTEX, fragment: BATCH_FRAGMENT });
      this.geometryClass = TwoColorGeometry;
      this.vertexSize = 7;
    }
    packInterleavedGeometry(element, attributeBuffer, indexBuffer, aIndex, iIndex) {
      const { uint32View, float32View } = attributeBuffer;
      const packedVertices = aIndex / this.vertexSize;
      const uvs = element.uvs, indices = element.indices, vertexData = element.vertexData;
      const base = element._texture.baseTexture;
      const textureId = base._batchLocation;
      const alpha = Math.min(element.worldAlpha, 1);
      const premultiplied = base.alphaMode > 0;
      // the light colour exactly as PIXI.BatchRenderer packs it
      const light = Color.shared.setValue(element._tintRGB).toPremultiplied(alpha, premultiplied);
      const dark = packDark(element.darkColor, alpha, premultiplied);
      for (let i = 0; i < vertexData.length; i += 2) {
        float32View[aIndex++] = vertexData[i];
        float32View[aIndex++] = vertexData[i + 1];
        float32View[aIndex++] = uvs[i];
        float32View[aIndex++] = uvs[i + 1];
        uint32View[aIndex++] = light;
        uint32View[aIndex++] = dark;
        float32View[aIndex++] = textureId;
      }
      for (let i = 0; i < indices.length; i++) indexBuffer[iIndex++] = packedVertices + indices[i];
    }
  }
  let meshProgram = null;
  /** PIXI.MeshMaterial whose shader adds the dark colour (darkColor: the slot's, straight rgb) as uDark. */
  class TwoColorMeshMaterial extends PIXI.MeshMaterial {
    constructor(texture) {
      meshProgram ||= PIXI.Program.from(MESH_VERTEX, MESH_FRAGMENT, 'spine-two-color-mesh');
      super(texture, { program: meshProgram, uniforms: { uDark: new Float32Array([0, 0, 0, 1]) } });
      // a small mesh joins the two-colour batch, as a MeshMaterial's joins the default one
      this.batchable = true;
      this.pluginName = NAME;
      this.darkColor = null;
    }
    update() {
      super.update();
      const u = this.uniforms.uDark, d = this.darkColor, premultiplied = this.texture.baseTexture.alphaMode > 0;
      const k = premultiplied ? this._alpha : 1;
      u[0] = d ? d.r * k : 0; u[1] = d ? d.g * k : 0; u[2] = d ? d.b * k : 0; u[3] = premultiplied ? 1 : 0;
    }
  }
  /** The renderer's two-colour batch, made the first time it draws a two-colour slot (other renderers never get one). */
  const plugin = (renderer) => {
    if (renderer.plugins[NAME]) return;
    const batch = renderer.plugins[NAME] = new TwoColorBatchRenderer(renderer);
    if (renderer.gl) batch.contextChange();
  };
  // The sprite / mesh of a slot with a dark colour holds that slot's Slot#darkColor itself (spine-ts keeps one Color per
  // slot and changes it in place: setup pose, TwoColorTimeline), so each draw reads the current dark colour — the light
  // one SpineBase#update sets as `tint` — and nothing runs per update.
  class TwoColorSprite extends S.SpineSprite {
    constructor(texture) {
      super(texture);
      this.pluginName = NAME;
      this.darkColor = null;
    }
    _render(renderer) {
      plugin(renderer);
      super._render(renderer);
    }
  }
  class TwoColorMesh extends S.SpineMesh {
    constructor(texture, vertices, uvs, indices, drawMode) {
      super(texture, vertices, uvs, indices, drawMode);
      this.shader = new TwoColorMeshMaterial(texture);
      this._darkColor = null;
    }
    /** The slot's dark colour, for the batch (`darkColor` of the element) and the material alike. */
    get darkColor() { return this._darkColor; }
    set darkColor(color) { this._darkColor = this.shader.darkColor = color; }
    _render(renderer) {
      plugin(renderer);
      super._render(renderer);
    }
  }
  const proto = S.SpineBase.prototype;
  const { createSprite, createMesh, newSprite, newMesh } = proto;
  // set while createSprite / createMesh make the sprite / mesh of a slot with a dark colour
  let twoColor = false;
  proto.newSprite = function (texture) {
    return twoColor ? new TwoColorSprite(texture) : newSprite.call(this, texture);
  };
  proto.newMesh = function (texture, vertices, uvs, indices, drawMode) {
    return twoColor ? new TwoColorMesh(texture, vertices, uvs, indices, drawMode) : newMesh.call(this, texture, vertices, uvs, indices, drawMode);
  };
  proto.createSprite = function (slot, attachment, name) {
    if (!slot.darkColor) return createSprite.call(this, slot, attachment, name);
    twoColor = true;
    let sprite;
    try { sprite = createSprite.call(this, slot, attachment, name); } finally { twoColor = false; }
    if (sprite instanceof TwoColorSprite) sprite.darkColor = slot.darkColor;
    return sprite;
  };
  proto.createMesh = function (slot, attachment) {
    if (!slot.darkColor) return createMesh.call(this, slot, attachment);
    twoColor = true;
    let mesh;
    try { mesh = createMesh.call(this, slot, attachment); } finally { twoColor = false; }
    if (mesh instanceof TwoColorMesh) mesh.darkColor = slot.darkColor;
    return mesh;
  };
  S.SpineBase.twoColorTint = true;
  Object.assign(S, { TwoColorBatchRenderer, TwoColorMeshMaterial, TwoColorMesh, TwoColorSprite });
  return true;
}

/** Text patches of a vendored file: file name in public/vendor → (source) → patched source. */
export const VENDOR_PATCHES = Object.freeze({ 'pixi-spine.js': (src) => patchPixiSpine(src).src });

/** [source under the repo root, file name in public/vendor, optional] */
export const VENDOR_FILES = Object.freeze([
  ['node_modules/ses/dist/ses.umd.js', 'ses.umd.js'],
  ['node_modules/acorn/dist/acorn.mjs', 'acorn.mjs'],
  ['node_modules/pixi.js/dist/pixi.min.js', 'pixi.min.js'],
  ['node_modules/pixi-spine/dist/pixi-spine.js', 'pixi-spine.js'],
  ['node_modules/preact/dist/preact.module.js', 'preact.module.js'],
  ['node_modules/preact/hooks/dist/hooks.module.js', 'hooks.module.js'],
  ['node_modules/htm/dist/htm.module.js', 'htm.module.js'],
  ['node_modules/three/build/three.core.js', 'three.core.js', true],
  ['node_modules/three/build/three.module.js', 'three.module.js', true],
]);

export function vendor({ log = console.log, warn = console.warn } = {}) {
  mkdirSync(out, { recursive: true });
  const done = [];
  for (const [src, dst, optional] of VENDOR_FILES) {
    const from = join(root, src);
    if (optional && !existsSync(from)) { warn(`vendor: ${dst} skipped (${src} not installed; the 3D board falls back to 2D)`); continue; }
    if (VENDOR_REWRITES[dst]) writeFileSync(join(out, dst), rewriteBare(readFileSync(from, 'utf8'), VENDOR_REWRITES[dst]));
    else if (VENDOR_PATCHES[dst]) writeFileSync(join(out, dst), VENDOR_PATCHES[dst](readFileSync(from, 'utf8')));
    else copyFileSync(from, join(out, dst));
    done.push(dst);
    log('vendor:', dst);
  }
  return done;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) vendor();
