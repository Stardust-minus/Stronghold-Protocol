import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retainManifestVoices } from '../tools/fetch-assets.mjs';

const ID = 'char_102_texas';
const url = (lang, file = 'cn_019.mp3') => `/assets/audio/voice/${lang}/${ID}/${file}`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'voice-alias-v022-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const lang of ['cn', 'jp', 'en']) {
    const dir = join(root, 'audio', 'voice', lang, ID);
    mkdirSync(dir, { recursive: true });
    for (const file of ['cn_019.mp3', 'cn_021.mp3']) writeFileSync(join(dir, file), 'fixture');
  }
  return root;
}

test('legacy-only JP plans keep their original shape and identity', (t) => {
  const next = { voice: { [ID]: { start: url('cn') } }, voiceJp: { [ID]: { start: url('jp') } } };
  const retained = retainManifestVoices(null, next, fixture(t));
  assert.equal(retained.audio, next);
  assert.equal(retained.files.size, 0);
});

test('a fresh legacy JP plan updates installed multilingual voices without losing CN/EN or mutating inputs', (t) => {
  const current = { voiceByLang: Object.fromEntries(['cn', 'jp', 'en'].map(lang => [lang, { [ID]: { start: url(lang) } }])) };
  const next = { voice: { [ID]: { start: url('cn') } }, voiceJp: { [ID]: { start: url('jp', 'cn_021.mp3') } }, bgm: { idle: '/assets/idle.mp3' } };
  const before = JSON.stringify({ current, next });
  const retained = retainManifestVoices(current, next, fixture(t));
  assert.equal(retained.audio.voiceByLang.jp[ID].start, url('jp', 'cn_021.mp3'));
  assert.equal(retained.audio.voiceJp, retained.audio.voiceByLang.jp);
  assert.equal(retained.audio.voice[ID].start, url('cn'));
  assert.equal(retained.audio.voiceByLang.en[ID].start, url('en'));
  assert.deepEqual(retained.audio.bgm, next.bgm);
  assert.equal(retained.files.size, 3);
  assert.equal(JSON.stringify({ current, next }), before);
});

test('an official-only JP manifest seeds the canonical tree when the next plan becomes multilingual', (t) => {
  const current = { voice: { [ID]: { start: url('cn') } }, voiceJp: { [ID]: { start: url('jp') } } };
  const next = { voiceByLang: { cn: { [ID]: { start: url('cn') } }, en: { [ID]: { start: url('en') } } } };
  const retained = retainManifestVoices(current, next, fixture(t));
  assert.equal(retained.audio.voiceJp[ID].start, url('jp'));
  assert.equal(retained.audio.voiceJp, retained.audio.voiceByLang.jp);
  assert.equal(retained.files.size, 3);
});

test('JP alias entries still require safe installed language paths', (t) => {
  const next = { voiceByLang: { cn: {} }, voiceJp: { [ID]: { start: url('jp', 'cn_999.mp3'), place: '/assets/audio/voice/jp/../bad.mp3' } } };
  const retained = retainManifestVoices(null, next, fixture(t));
  assert.deepEqual(retained.audio.voiceJp, {});
  assert.equal(retained.files.size, 0);
});
