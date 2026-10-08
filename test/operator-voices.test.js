import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs, orphanFiles } from '../tools/fetch-assets.mjs';
import { indexAudio, normalizeVoiceLangs, retainInstalledVoices } from '../tools/assets/audio.mjs';
import { buildPlan } from '../tools/assets/plan.mjs';
import { collectLeaves, resolveTemplate, contentHash, droppedEntries } from '../tools/assets/manifest.mjs';
import { operatorVoicePlan, mergeOperatorVoices, voiceManifestMetadata, validateVoiceFile, prepareOperatorVoices, parseVoicePreparationArgs } from '../tools/prepare-operator-voices.mjs';

const ID = 'char_102_texas', OTHER = 'char_1051_headb2';
const url = (lang, id = ID, file = 'cn_019.mp3') => `/assets/audio/voice/${lang}/${id}/${file}`;
const charword = { charWords: Object.fromEntries([
  ['CN_019', 'BATTLE_START', 19], ['CN_021', 'BATTLE_SELECT', 21], ['CN_022', 'BATTLE_SELECT', 22], ['CN_018', 'GACHA', 18],
].map(([voiceId, placeType, voiceIndex]) => [voiceId, { charId: ID, wordKey: ID, voiceId, placeType, voiceIndex, voiceAsset: `${ID}/${voiceId}` }])) };
const plan = (opts = {}) => buildPlan({ assets07: { operators: { [ID]: {} } }, ops03: {}, enemies05: {}, maps05: {}, audio: indexAudio({}), modelsData: {}, charword, ...opts }).template;
const fixture = () => ({ version: 1, hash: 'old', generator: 'tools/fetch-assets.mjs', stats: { chars: 1, files: 0, bytes: 0, voiceChars: 1 }, chars: { [ID]: { avatar: '/assets/test.png' } }, skins: { unrelated: { literal: true } }, fonts: { faces: {} }, audio: { voice: { [ID]: { start: url('cn'), select: [url('cn', ID, 'cn_021.mp3'), url('cn', ID, 'cn_022.mp3')] } }, bgm: { combat: '/assets/music.mp3' }, sfx: { ui: { click: '/assets/click.mp3' } } } });
const row = (id = ID, en = true) => ({ charId: id, name: id === ID ? '德克萨斯' : '怒潮凛冬', declaredPaths: { cn: [`voice_cn/${id}`], jp: [`voice/${id}`], other: en ? [`voice_en/${id}`] : [`voice_en/${id}_skin__1`] }, eventFiles: { 19: 'CN_019.wav', 21: 'CN_021.wav', 22: 'CN_022.wav' } });
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'operator-voices-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const put = (root, rel, bytes = Buffer.from('fixture')) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), bytes); };

test('old CLI and single-language plans remain unchanged; multilingual is opt-in', () => {
  assert.equal(parseArgs([]).voiceLang, 'cn');
  assert.equal(parseArgs([]).voiceAll, false);
  assert.equal(Object.hasOwn(parseArgs([]), 'voiceLangs'), false);
  assert.equal(Object.hasOwn(plan().audio, 'voiceByLang'), false);
  assert.equal(plan().audio.voice[ID].start.alts[0].rel, `audio/voice/cn/${ID}/cn_019.mp3`);
  assert.equal(plan({ voiceLang: 'jp' }).audio.voice[ID].start.alts[0].rel, `audio/voice/jp/${ID}/cn_019.mp3`);
  assert.equal(plan().audio.voice[ID].gacha, undefined);
  assert.ok(plan({ voiceSlots: null }).audio.voice[ID].gacha);
});

test('repeated/list voice-langs deduplicates and retains CN; mixed legacy flag is order-independent', () => {
  assert.deepEqual(normalizeVoiceLangs(['jp,en', 'jp', 'cn']), ['jp', 'en', 'cn']);
  assert.deepEqual(parseArgs(['--voice-langs=jp,en', '--voice-langs=cn,jp']).voiceLangs, ['cn', 'jp', 'en']);
  assert.deepEqual(parseArgs(['--voice-langs=en', '--voice-lang=jp']).voiceLangs, ['cn', 'jp', 'en']);
  assert.deepEqual(parseArgs(['--voice-lang=jp', '--voice-langs=en']).voiceLangs, ['cn', 'jp', 'en']);
  for (const lang of ['xx', '', 'en,', '__proto__', 'constructor', 'JP']) {
    assert.throws(() => parseArgs([`--voice-langs=${lang}`]), /unknown voice language/);
    assert.throws(() => buildPlan({ ...{}, voiceLang: lang }), /unknown voice language/);
  }
  assert.throws(() => normalizeVoiceLangs([]), /must not be empty/);
});

test('multilingual plan retains legacy CN and isolates language paths without changing other sections', () => {
  const legacy = plan(), multi = plan({ voiceLangs: ['jp', 'en'] });
  assert.deepEqual(multi.audio.voice, legacy.audio.voice);
  assert.deepEqual(multi.audio.voiceByLang.cn, legacy.audio.voice);
  assert.deepEqual(Object.keys(multi.audio.voiceByLang), ['cn', 'jp', 'en']);
  for (const lang of ['cn', 'jp', 'en']) {
    const voice = multi.audio.voiceByLang[lang][ID];
    assert.equal(voice.select.length, 2);
    assert.match(voice.start.alts[0].urls[0], new RegExp(`/${lang === 'cn' ? 'voice_cn' : lang === 'jp' ? 'voice' : 'voice_en'}/${ID}/cn_019\\.mp3$`));
  }
  const { voiceByLang, ...audio } = multi.audio;
  assert.deepEqual({ ...multi, audio }, legacy);
});

test('template resolution admits only files that actually exist; missing EN never replaces CN', (t) => {
  const root = temp(t);
  put(root, `audio/voice/cn/${ID}/cn_019.mp3`);
  put(root, `audio/voice/jp/${ID}/cn_021.mp3`);
  const resolved = resolveTemplate({ audio: plan({ voiceLangs: ['jp', 'en'] }).audio }, { root, spine: new Map() });
  assert.equal(resolved.value.audio.voice[ID].start, url('cn'));
  assert.deepEqual(resolved.value.audio.voiceByLang.jp[ID].select, [url('jp', ID, 'cn_021.mp3')]);
  assert.equal(resolved.value.audio.voiceByLang.en, undefined);
  assert.equal(resolved.files.size, 2, 'duplicate CN compatibility URLs count once');
});

test('installed languages stay referenced across default rebuild and prune, including original CN', (t) => {
  const root = temp(t), current = fixture().audio;
  for (const lang of ['cn', 'jp', 'en']) put(root, `audio/voice/${lang}/${ID}/cn_019.mp3`);
  current.voiceByLang = { cn: { [ID]: { start: url('cn') } }, jp: { [ID]: { start: url('jp') } }, en: { [ID]: { start: url('en') } } };
  const next = { voice: { [ID]: { start: url('cn') } }, sfx: {} };
  const retained = retainInstalledVoices(current, next, root);
  assert.deepEqual(retained.audio.voice, next.voice);
  assert.deepEqual(Object.keys(retained.audio.voiceByLang), ['cn', 'jp', 'en']);
  assert.equal(retained.files.size, 3);
  assert.deepEqual(orphanFiles([...retained.files, 'audio/unused.mp3'], retained.files), ['audio/unused.mp3']);
  assert.deepEqual(droppedEntries({ audio: current.voiceByLang }, { audio: retained.audio.voiceByLang }), []);
  assert.equal(retainInstalledVoices(null, next, root).audio, next, 'legacy-only default shape is unchanged');
});

test('a legacy JP refresh of an installed multilingual manifest keeps CN and counts only final references', (t) => {
  const root = temp(t);
  for (const lang of ['cn', 'jp']) for (const file of ['cn_019.mp3', 'cn_021.mp3']) put(root, `audio/voice/${lang}/${ID}/${file}`);
  const current = { voice: { [ID]: { start: url('cn') } }, voiceByLang: { cn: { [ID]: { start: url('cn') } }, jp: { [ID]: { start: url('jp') } } } };
  const next = { voice: { [ID]: { start: url('jp', ID, 'cn_021.mp3') } } };
  const kept = retainInstalledVoices(current, next, root);
  assert.deepEqual(kept.audio.voice, current.voice);
  assert.equal(kept.audio.voiceByLang.jp[ID].start, url('jp', ID, 'cn_021.mp3'));
  assert.deepEqual([...kept.files].sort(), [`audio/voice/cn/${ID}/cn_019.mp3`, `audio/voice/jp/${ID}/cn_021.mp3`]);
});

test('retention rejects traversal, other char IDs and nonexistent language files', (t) => {
  const root = temp(t);
  const next = { voice: {}, voiceByLang: { cn: {}, jp: { [ID]: { start: '/assets/audio/voice/jp/../bad.mp3', select: url('jp', OTHER), place: url('jp') } } } };
  assert.deepEqual(retainInstalledVoices(null, next, root).audio.voiceByLang, { cn: {}, jp: {} });
});

test('targeted candidates require declared base paths, not skins or guessed language roots', () => {
  const manifest = fixture();
  manifest.audio.voice[OTHER] = { start: url('cn', OTHER) };
  const p = operatorVoicePlan(manifest, { rows: [row(), row(OTHER, false)] });
  assert.equal(p.jobs.filter((j) => j.language === 'en').length, 3);
  assert.deepEqual(p.excluded, [{ language: 'en', charId: OTHER, name: '怒潮凛冬', missingSlots: 1, missingFiles: 1, reason: 'base-directory-not-declared' }]);
  assert.equal(p.jobs.find((j) => j.language === 'en').path, `/assets/audio/voice_en/${ID}/cn_019.mp3`);
  assert.throws(() => operatorVoicePlan(manifest, { rows: [row()] }), /coverage missing/);
  assert.throws(() => operatorVoicePlan(manifest, { rows: [row(), row()] }), /duplicate coverage/);
  assert.throws(() => operatorVoicePlan(fixture(), { rows: [row()] }, ['kr']), /cn \| jp \| en only/);
  const bad = fixture(); bad.audio.voice[ID].start = url('jp');
  assert.throws(() => operatorVoicePlan(bad, { rows: [row()] }), /not a base CN battle file/);
});

test('incremental merge changes only voiceByLang/hash/stats; statistics deduplicate legacy CN', (t) => {
  const root = temp(t), old = fixture(), before = JSON.stringify(old);
  for (const value of ['test.png', 'music.mp3', 'click.mp3']) put(root, value);
  const p = operatorVoicePlan(old, { rows: [row()] });
  for (const job of p.jobs) put(root, job.rel);
  const next = mergeOperatorVoices(old, p, p.jobs.map((j) => j.rel), root);
  assert.equal(JSON.stringify(old), before, 'does not mutate the previous manifest');
  assert.equal(next.audio.voice, old.audio.voice);
  assert.equal(next.audio.voiceByLang.cn, old.audio.voice);
  const { voiceByLang, ...audio } = next.audio;
  const { hash, stats, ...body } = next, { hash: oldHash, stats: oldStats, ...oldBody } = old;
  assert.deepEqual({ ...body, audio }, oldBody);
  assert.equal(next.stats.files, 12);
  assert.equal(next.stats.bytes, 12 * Buffer.byteLength('fixture'));
  assert.equal(next.stats.voiceChars, old.stats.voiceChars);
  const { version: v, generator: g, hash: h, stats: s, ...hashBody } = next;
  assert.equal(next.hash, contentHash(hashBody));
  assert.deepEqual(voiceManifestMetadata(next, root), next);
  assert.throws(() => mergeOperatorVoices(old, p, ['../escape.mp3'], root), /uninstalled or unplanned/);
  rmSync(join(root, p.jobs[0].rel));
  assert.throws(() => mergeOperatorVoices(old, p, [p.jobs[0].rel], root), /uninstalled or unplanned/);
});

const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
function mp3Fixture(dir) {
  const file = join(dir, 'fixture.mp3');
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-ac', '1', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '32k', file]);
  assert.equal(r.status, 0, r.stderr?.toString());
  return readFileSync(file);
}

test('complete-file validator verifies actual MP3 decode/hash and rejects invalid or mismatched data', { skip: !ffmpeg }, async (t) => {
  const dir = temp(t), bytes = mp3Fixture(dir), file = join(dir, 'fixture.mp3');
  const result = await validateVoiceFile(file);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.stream.codec_name, 'mp3');
  await assert.rejects(validateVoiceFile(file, { bytes: bytes.length, sha256: '0'.repeat(64) }), /receipt\/body mismatch/);
  writeFileSync(join(dir, 'bad.mp3'), Buffer.from('ID3not-actually-mp3'));
  await assert.rejects(validateVoiceFile(join(dir, 'bad.mp3')));
});

test('offline targeted preparation fully validates CN and new bodies, ignores unsuccessful EN receipts', { skip: !ffmpeg }, async (t) => {
  const dir = temp(t), source = join(dir, 'downloaded'), assets = join(dir, 'assets');
  mkdirSync(source); mkdirSync(assets);
  const bytes = mp3Fixture(dir), manifest = fixture(), manifestPath = join(dir, 'assets.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const p = operatorVoicePlan(manifest, { rows: [row()] }), receipts = [];
  for (const job of p.jobs) {
    if (job.language === 'cn') put(assets, job.rel, bytes);
    else {
      put(source, job.rel, bytes);
      receipts.push({ ...job, status: job.language === 'en' && job.file === 'cn_022.mp3' ? 'http-missing' : 'verified', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  const report = await prepareOperatorVoices({ sourceDir: source, assetRoot: assets, manifestPath, coverage: { rows: [row()] }, receipt: receipts });
  assert.equal(report.manifestWritten, true);
  assert.deepEqual(report.verifiedByLang, { cn: 3, jp: 3, en: 2 });
  assert.equal(report.failures.length, 0);
  assert.equal(report.missing.length, 1);
  assert.equal(report.fallbackCoverage.en.missingFileCount, 1);
  const next = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(next.audio.voice, manifest.audio.voice);
  assert.deepEqual(next.audio.voiceByLang.en[ID].select, [url('en', ID, 'cn_021.mp3')]);
  for (const lang of Object.values(next.audio.voiceByLang)) for (const slots of Object.values(lang)) for (const value of Object.values(slots)) for (const u of Array.isArray(value) ? value : [value]) assert.ok(existsSync(join(assets, u.slice('/assets/'.length))), u);
  assert.equal(existsSync(join(assets, `audio/voice/en/${ID}/cn_022.mp3`)), false);
});

test('CN validation failure cannot write a new manifest or import remote voices', { skip: !ffmpeg }, async (t) => {
  const dir = temp(t), source = join(dir, 'downloaded'), assets = join(dir, 'assets');
  mkdirSync(source); mkdirSync(assets);
  const manifestPath = join(dir, 'assets.json'), original = JSON.stringify(fixture());
  writeFileSync(manifestPath, original);
  const report = await prepareOperatorVoices({ sourceDir: source, assetRoot: assets, manifestPath, coverage: { rows: [row()] } });
  assert.equal(report.manifestWritten, false);
  assert.equal(readFileSync(manifestPath, 'utf8'), original);
  assert.deepEqual(report.verifiedByLang, { cn: 0, jp: 0, en: 0 });
});

test('fetch-sources stops after a real refusal status, with no retries or alternative source', { skip: !ffmpeg }, async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const status of [403, 429]) {
    const dir = temp(t), source = join(dir, 'downloaded'), assets = join(dir, 'assets');
    mkdirSync(assets);
    const bytes = mp3Fixture(dir), manifest = fixture(), manifestPath = join(dir, 'assets.json');
    const prior = JSON.stringify(manifest); writeFileSync(manifestPath, prior);
    const p = operatorVoicePlan(manifest, { rows: [row()] });
    for (const job of p.jobs.filter((job) => job.language === 'cn')) put(assets, job.rel, bytes);
    let requests = 0;
    globalThis.fetch = async (sourceUrl, options) => {
      requests++;
      assert.match(sourceUrl, /^https:\/\/torappu\.prts\.wiki\/assets\/audio\/voice\//);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Cookie, undefined);
      return new Response(null, { status });
    };
    const report = await prepareOperatorVoices({ sourceDir: source, assetRoot: assets, manifestPath, coverage: { rows: [row()] }, fetchSources: true, concurrency: 1 });
    assert.equal(requests, 1, `HTTP${status}: no retry or next request`);
    assert.equal(report.blocked, true);
    assert.equal(report.manifestWritten, false);
    assert.equal(report.retries, 0);
    assert.equal(readFileSync(manifestPath, 'utf8'), prior);
    assert.equal(report.failures[0].reason, `HTTP${status}`);
  }
});

test('targeted CLI validates languages and max-two/no-retry boundaries before any work', () => {
  const flags = ['--source-dir=/tmp/source', '--coverage=/tmp/coverage', '--report=/tmp/report'];
  assert.deepEqual(parseVoicePreparationArgs([...flags, '--voice-langs=jp', '--voice-langs=en']).languages, ['cn', 'jp', 'en']);
  assert.throws(() => parseVoicePreparationArgs([...flags, '--concurrency=3']), /must be 1 or 2/);
  assert.throws(() => parseVoicePreparationArgs([...flags, '--voice-langs=kr']), /cn \| jp \| en only/);
  assert.throws(() => parseVoicePreparationArgs([...flags, '--fetch-sources', '--receipt=/tmp/receipt']), /not a download retry/);
  assert.throws(() => parseVoicePreparationArgs([...flags, '--prune']), /unknown option/);
});
