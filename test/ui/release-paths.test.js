import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseBase, releaseResource, pinAssetManifest } from '../../public/js/release.js';
import { defaultWsUrl } from '../../public/js/net.js';
import { mediaUrl } from '../../public/js/media.js';
import { loadBoardArt, resetBoardArt } from '../../public/js/render/boardArt.js';

test('release page pins resources and websocket; root direct deployments stay unchanged', () => {
  const path = '/_release/v012-alliance/public/';
  assert.equal(releaseBase(path), '/_release/v012-alliance');
  assert.equal(releaseResource('/vendor/pixi.min.js', path), '/_release/v012-alliance/public/vendor/pixi.min.js');
  assert.equal(releaseResource('/data/chess.json', '/'), '/data/chess.json');
  assert.equal(defaultWsUrl({ protocol: 'https:', host: 'game.example', pathname: path }), 'wss://game.example/_release/v012-alliance/ws');
  assert.equal(defaultWsUrl({ protocol: 'http:', host: '127.0.0.1:3000', pathname: '/' }), 'ws://127.0.0.1:3000/ws');
});

test('physical module paths keep shared imports within the same release', () => {
  const base = 'https://game.example';
  const page = '/_release/r1/public/';
  for (const [file, relative] of [['/js/net.js', '../../shared/constants.js'], ['/js/screens/room.js', '../../../shared/constants.js'], ['/sim/constants.js', '../../shared/constants.js']]) {
    const url = new URL(releaseResource(file, page), base);
    assert.equal(new URL(relative, url).pathname, '/_release/r1/shared/constants.js');
  }
  const support = new URL(releaseResource('/sim/content/support/index.js', page), base);
  assert.equal(new URL('../../../data.js', support).pathname, '/_release/r1/server/data.js');
});

test('external resources, gate routes and already pinned paths never move to another release', () => {
  const path = '/_release/next/';
  for (const url of ['https://cdn.example/a.png', '//cdn.example/a.png', 'data:image/png,a', '/entry', '/api/profile', '/_release/old/assets/a.png']) {
    assert.equal(releaseResource(url, path), url);
  }
  assert.equal(releaseBase('/_release/bad%2Fid/'), '');
  assert.equal(releaseBase('/something/_release/valid/'), '');
});

test('art manifest pinning does not mutate inputs, numbers or non-path text', () => {
  const original = { chars: { p: { avatar: '/assets/p.png' } }, pages: ['/assets/a.png'], n: 10, label: 'doctor' };
  const pinned = pinAssetManifest(original, '/_release/r1/');
  assert.equal(pinned.chars.p.avatar, '/_release/r1/public/assets/p.png');
  assert.equal(pinned.pages[0], '/_release/r1/public/assets/a.png');
  assert.equal(pinned.n, 10);
  assert.equal(original.chars.p.avatar, '/assets/p.png');
  assert.equal(pinAssetManifest(original, '/'), original);
  assert.deepEqual(pinAssetManifest(pinned, '/_release/r2/'), pinned);
});

test('nested board tile manifests cannot fetch unversioned textures', async () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const oldFetch = globalThis.fetch;
  const images = [];
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/_release/r1/public/' } });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: 1, materials: {}, source: { D: { path: '/assets/local/board.png' } } }) });
    resetBoardArt();
    const art = await loadBoardArt({ local: async () => ({}), localUrl: () => '/_release/r1/public/assets/local/atlas.png', image: async url => { images.push(url); return { width: 1 }; } });
    assert.ok(art);
    assert.deepEqual(images, ['/_release/r1/public/assets/local/board.png']);
  } finally {
    resetBoardArt(); globalThis.fetch = oldFetch;
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete globalThis.location;
  }
});

test('extensionless audio retains owning release and original range-capable route', () => {
  assert.equal(mediaUrl('/_release/r1/public/assets/audio/bgm/music.mp3?v=1', 'https://game.example'), '/_release/r1/public/media/bgm/music?v=1');
  assert.equal(mediaUrl('/assets/audio/bgm/music.mp3', 'https://game.example'), '/media/bgm/music');
  assert.equal(mediaUrl('https://cdn.example/assets/audio/music.mp3', 'https://game.example'), 'https://cdn.example/assets/audio/music.mp3');
});
