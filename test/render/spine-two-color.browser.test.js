// The vendored pixi-spine draws a slot's dark colour (two-colour tint: tools/vendor.mjs installSpineTwoColorTint,
// docs/history/0.4.0.md §37.242) the way spine-webgl 3.8 does. A synthetic Spine 3.8 skeleton — a light-only slot and
// light + dark slots, as a region (sprite batch), a 4-vertex mesh (batched) and a 121-vertex mesh (drawn on its own), one
// half-transparent page area, one slot at half alpha — is drawn by the page's PIXI over black and over white, from a
// straight page (premultiplied on upload) and from a premultiplied one (pma), and read back against spine-webgl's
// formula for a straight page (out = (1 − t)·dark + t·light, blended by its alpha).
// RENDER_E2E=1 node --test test/render/spine-two-color.browser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = process.env.RENDER_E2E !== '1' || !existsSync(CHROME);

// page texel colour (straight): x < 8 opaque, x >= 8 alpha 128
const TEX = [204, 102, 51];
// slots, left to right: [name, attachment kind, page area, light rgba, dark rgb | null]
const SLOTS = [
  ['plain', 'region', 'solid', 'ff8040ff', null],
  ['dark', 'region', 'solid', 'ff8040ff', '3366cc'],
  ['darkHalfPage', 'region', 'half', 'ffffffff', 'ff8000'],
  ['darkHalfAlpha', 'region', 'solid', 'c0ffc080', '40c080'],
  ['darkMesh4', 'mesh4', 'solid', 'ffc0a0ff', '204080'],
  ['darkMesh121', 'mesh121', 'solid', 'a0ffffff', 'c04020'],
];
const hex = (s, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16) / 255;

/** spine-webgl 3.8, straight page: the pixel over a background of 0 / 1 (0..255). */
function official(slot, bg) {
  const [, , area, light, dark] = slot;
  const ta = area === 'half' ? 128 / 255 : 1, t = TEX.map((v) => v / 255);
  const L = [0, 1, 2].map((c) => hex(light, c)), la = hex(light, 3), D = dark ? [0, 1, 2].map((c) => hex(dark, c)) : [0, 0, 0];
  const a = ta * la;
  return [0, 1, 2].map((c) => Math.round((((1 - t[c]) * D[c] + t[c] * L[c]) * a + bg * (1 - a)) * 255));
}

test('two-colour tint: region, batched mesh and own-draw mesh match spine-webgl, straight and premultiplied pages', { skip, timeout: 90000 }, async () => {
  const { startServer } = await import('../../server/index.js');
  const puppeteer = (await import('puppeteer-core')).default;
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.port}/manifest.json`);
    const got = await page.evaluate(async (SLOTS, TEX) => {
      const { ensurePixi } = await import('/js/render/app/pixi.js');
      const PIXI = await ensurePixi();
      const { spineLoadParser } = await import('/js/themeSpine.js');
      const W = 32 * SLOTS.length + 16, H = 96;
      const atlasText = 'page.png\nsize: 16,16\nformat: RGBA8888\nfilter: Nearest,Nearest\nrepeat: none\n'
        + 'solid\n  rotate: false\n  xy: 0, 0\n  size: 8, 16\n  orig: 8, 16\n  offset: 0, 0\n  index: -1\n'
        + 'half\n  rotate: false\n  xy: 8, 0\n  size: 8, 16\n  orig: 8, 16\n  offset: 0, 0\n  index: -1\n';
      // a grid mesh of n × n vertices over its region, 32 × 64 units, centred on (x, 0)
      const grid = (n, x) => {
        const uvs = [], vertices = [], triangles = [];
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { uvs.push(i / (n - 1), j / (n - 1)); vertices.push(x - 16 + (32 * i) / (n - 1), 32 - (64 * j) / (n - 1)); }
        for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const k = j * n + i; triangles.push(k, k + 1, k + n, k + 1, k + n + 1, k + n); }
        return { type: 'mesh', uvs, triangles, vertices, hull: 4 * (n - 1), width: 32, height: 64 };
      };
      const x0 = -(SLOTS.length - 1) * 16;
      const skin = {};
      SLOTS.forEach(([name, kind, area], i) => {
        const x = x0 + i * 32;
        skin[name] = { [area]: kind === 'region' ? { x, y: 0, width: 8, height: 16, scaleX: 4, scaleY: 4 } : grid(kind === 'mesh4' ? 2 : 11, x) };
      });
      const json = { skeleton: { spine: '3.8.99', width: W, height: H }, bones: [{ name: 'root' }],
        slots: SLOTS.map(([name, , area, light, dark]) => ({ name, bone: 'root', attachment: area, color: light, ...(dark ? { dark } : {}) })),
        skins: [{ name: 'default', attachments: skin }], animations: { idle: {} } };
      const parser = spineLoadParser(PIXI);
      const draw = async (pma) => {
        const px = new Uint8Array(16 * 16 * 4);
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
          const a = x < 8 ? 255 : 128, o = (y * 16 + x) * 4;
          for (let c = 0; c < 3; c++) px[o + c] = pma ? Math.round((TEX[c] * a) / 255) : TEX[c];
          px[o + 3] = a;
        }
        const base = PIXI.BaseTexture.fromBuffer(px, 16, 16, { alphaMode: pma ? PIXI.ALPHA_MODES.PMA : PIXI.ALPHA_MODES.UNPACK, scaleMode: PIXI.SCALE_MODES.NEAREST });
        const spineAtlas = await new Promise((resolve) => new PIXI.spine.TextureAtlas(atlasText, (p, done) => done(base), resolve));
        const res = await parser.parse(structuredClone(json), { src: 'two-colour.json', data: { spineAtlas } }, PIXI.Assets.loader);
        const actor = new PIXI.spine.Spine(res.spineData || res);
        actor.autoUpdate = false; actor.update(0);
        actor.position.set(W / 2, H / 2);
        const renderer = new PIXI.Renderer({ width: W, height: H, backgroundColor: 0, backgroundAlpha: 1, antialias: false, preserveDrawingBuffer: true });
        const stage = new PIXI.Container(); stage.addChild(actor);
        const { TwoColorSprite, TwoColorMesh } = PIXI.spine;
        const kinds = SLOTS.map(([name]) => { const s = actor.skeleton.findSlot(name); return { sprite: !!TwoColorSprite && s.currentSprite instanceof TwoColorSprite, mesh: !!TwoColorMesh && s.currentMesh instanceof TwoColorMesh }; });
        const read = (bg) => {
          renderer.background.color = bg; renderer.render(stage);
          const gl = renderer.gl, out = [];
          for (let i = 0; i < SLOTS.length; i++) { const p = new Uint8Array(4); gl.readPixels(Math.round(W / 2 + x0 + i * 32), H / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); out.push([p[0], p[1], p[2]]); }
          return out;
        };
        const r = { black: read(0x000000), white: read(0xffffff), kinds, twoColor: !!PIXI.spine.SpineBase.twoColorTint, batch: !!renderer.plugins.spineTwoColorBatch };
        actor.destroy(); renderer.destroy(false); base.destroy();
        return r;
      };
      return { straight: await draw(false), pma: await draw(true) };
    }, SLOTS, TEX);
    assert.deepEqual(errors, []);
    for (const [mode, r] of Object.entries(got)) {
      for (const [i, slot] of SLOTS.entries()) {
        for (const [bg, read] of [[0, r.black[i]], [1, r.white[i]]]) {
          const want = official(slot, bg);
          const off = Math.max(...read.map((v, c) => Math.abs(v - want[c])));
          assert.ok(off <= 3, `${mode} ${slot[0]} over ${bg ? 'white' : 'black'}: ${read} vs spine-webgl ${want}`);
        }
      }
      assert.ok(r.twoColor && r.batch, `${mode}: the bundle has the two-colour tint and drew through its batch`);
      assert.deepEqual(r.kinds.map((k) => k.sprite || k.mesh), SLOTS.map((s) => !!s[4]), `${mode}: only slots with a dark colour draw two-colour`);
    }
  } finally { await browser?.close(); await srv.close(); }
});
