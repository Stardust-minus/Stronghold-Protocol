import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { defaultWsUrl } from '../../public/js/net.js';
import { mediaUrl } from '../../public/js/media.js';
import { loadBoardArt, resetBoardArt } from '../../public/js/render/boardArt.js';

test('game websocket always uses the single root endpoint', () => {
  for (const pathname of ['/', '/index.html', '/_release/old/public/']) {
    assert.equal(defaultWsUrl({ protocol: 'https:', host: 'game.example', pathname }), 'wss://game.example/ws');
  }
  assert.equal(defaultWsUrl({ protocol: 'http:', host: '127.0.0.1:3000' }), 'ws://127.0.0.1:3000/ws');
});

test('nested board art uses the original manifest paths without rewriting', async () => {
  const previous = globalThis.fetch;
  const images = [];
  try {
    globalThis.fetch = async url => {
      assert.equal(url, '/assets/local/tiles.json');
      return { ok: true, json: async () => ({ version: 1, materials: {}, source: { D: { path: '/assets/local/board.png' } } }) };
    };
    resetBoardArt();
    const art = await loadBoardArt({ local: async () => ({}),
      localUrl: (_group, name) => name === 'TX_autochessi_D' ? '/assets/local/atlas.png' : null,
      image: async url => { images.push(url); return { width: 1 }; } });
    assert.ok(art);
    assert.deepEqual(images, ['/assets/local/board.png']);
  } finally { resetBoardArt(); globalThis.fetch = previous; }
});

test('board art follows the matching manifest WebP without adding a release prefix', async () => {
  const previous = globalThis.fetch;
  const images = [];
  const dir = '/assets/local/map/autochess';
  const texture = 'TX_autochessi_D';
  try {
    globalThis.fetch = async url => {
      assert.equal(url, `${dir}/tiles.json`);
      return { ok: true, json: async () => ({ version: 1, materials: {}, source: { D: { path: `${dir}/${texture}.png` } } }) };
    };
    resetBoardArt();
    const art = await loadBoardArt({ local: async () => ({}),
      localUrl: (_group, name) => name === texture ? `${dir}/${texture}.webp` : null,
      image: async url => { images.push(url); return { width: 1 }; } });
    assert.ok(art);
    assert.deepEqual(images, [`${dir}/${texture}.webp`]);
    assert.equal(art.key, `${dir}/${texture}.webp#1`);
  } finally { resetBoardArt(); globalThis.fetch = previous; }
});

test('audio retains extensionless root route and never rewrites external media', () => {
  assert.equal(mediaUrl('/assets/audio/bgm/music.mp3?v=1', 'https://game.example'), '/media/bgm/music?v=1');
  assert.equal(mediaUrl('https://cdn.example/assets/audio/music.mp3', 'https://game.example'), 'https://cdn.example/assets/audio/music.mp3');
});

test('obsolete client release router and update notice are absent', () => {
  for (const file of ['release.js', 'ui/serverUpdate.js']) assert.equal(existsSync(new URL('../../public/js/' + file, import.meta.url)), false);
  for (const file of ['main.js', 'assets.js', 'data.js', 'media.js', 'net.js', 'ui/buildGuard.js', 'battle/runner.js', 'render/app.js', 'render/fx.js', 'render/boardArt.js', 'render/board3d/load.js', 'ui/emotes.js']) {
    const source = readFileSync(new URL('../../public/js/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /releaseResource|pinAssetManifest|releaseBase|installReleasePresence|ServerUpdateNotice|server\.draining/, file);
  }
});
