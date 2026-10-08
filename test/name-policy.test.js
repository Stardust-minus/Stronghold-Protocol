import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { moderateName, createNamePolicy, sanitizeName, NAME_POLICY_LIMITS } from '../shared/names.js';
import { moderateName as authPolicy, categoryWords } from '../deploy/stardust/auth/name-policy.mjs';
import { NAME_DICTIONARY_SOURCE, ENGLISH_TEXT, CHINESE_TEXT } from '../deploy/stardust/auth/name-dictionary.mjs';
import Mint, { NAME_FILTER_SOURCE } from '../deploy/stardust/auth/name-filter-vendor.mjs';
import { CATEGORY_DICTIONARY_SOURCE, POLITICAL_DICTIONARY_SOURCE, POLITICAL_TEXT, ADULT_TEXT, ILLEGAL_TEXT,
  TAGGED_POLITICAL_TEXT } from '../deploy/stardust/auth/name-sensitive-dictionary.mjs';
import { ERR, NAME_MAX_LEN } from '../shared/constants.js';
import { Network, SessionRegistry } from '../server/net.js';
import { TestClient } from './helpers/wsClient.js';
import { createGate, makeSecrets, validateSecrets, signToken, ORIGIN, SESSION_COOKIE } from '../deploy/stardust/auth/server.mjs';

const ROOT = new URL('../', import.meta.url);
const MODERATION_FILES = ['name-policy.mjs', 'name-dictionary.mjs', 'name-sensitive-dictionary.mjs',
  'name-filter-vendor.mjs', 'name-filter-node.mjs', 'NAME-DICTIONARY-LICENSE.txt', 'NAME-FILTER-LICENSE.txt',
  'NAME-CATEGORIES-LICENSE.txt', 'NAME-POLITICAL-LICENSE.txt'];
const hash = text => createHash('sha256').update(text).digest('hex');
const politicalWords = categoryWords(POLITICAL_TEXT).concat(categoryWords(TAGGED_POLITICAL_TEXT));

// Titles/assertion messages deliberately contain no submitted or matched sensitive terms.
test('actual pinned upstream detector code and MIT license retain verified hashes', t => {
  assert.equal(NAME_FILTER_SOURCE.version, '4.0.3');
  assert.equal(NAME_FILTER_SOURCE.license, 'MIT');
  assert.match(NAME_FILTER_SOURCE.integrity, /^sha512-/);
  const engine = readFileSync(new URL('deploy/stardust/auth/name-filter-vendor.mjs', ROOT), 'utf8');
  const importLine = "import Node from './name-filter-node.mjs';";
  const upstreamCode = engine.slice(engine.indexOf(importLine)).replace(importLine, "import Node from './node';");
  assert.equal(hash(upstreamCode), NAME_FILTER_SOURCE.sha256.upstreamEngine, 'matching engine is unchanged upstream code');
  assert.equal(hash(readFileSync(new URL('deploy/stardust/auth/name-filter-node.mjs', ROOT))), NAME_FILTER_SOURCE.sha256.node);
  assert.equal(hash(readFileSync(new URL('deploy/stardust/auth/NAME-FILTER-LICENSE.txt', ROOT))), NAME_FILTER_SOURCE.sha256.license);
  const verify = Mint.prototype.verify;
  let calls = 0;
  Mint.prototype.verify = function (text) { calls++; return verify.call(this, text); };
  t.after(() => { Mint.prototype.verify = verify; });
  const policy = createNamePolicy({ english: ['blocked'], chinese: [], political: [], extraEnglish: [], extraChinese: [] });
  assert.equal(policy('Amiya').ok, true);
  assert.equal(policy('blocked').reason, 'sensitive');
  assert.ok(calls > 0, 'adapter invokes the actual upstream detection method');
});

test('categorized native corpora retain pinned revisions, exact data and Apache attribution', () => {
  assert.equal(CATEGORY_DICTIONARY_SOURCE.revision, 'a7d06bb1c321e669943b6841570d9da6dad8ce2b');
  assert.equal(POLITICAL_DICTIONARY_SOURCE.revision, 'fe6fc2921836217b8c90619db81b24af8b22d80f');
  assert.equal(CATEGORY_DICTIONARY_SOURCE.license, 'Apache-2.0');
  assert.equal(POLITICAL_DICTIONARY_SOURCE.license, 'Apache-2.0');
  for (const [text, filename, count] of [[POLITICAL_TEXT, '政治类.txt', 326], [ADULT_TEXT, '色情类.txt', 304],
    [ILLEGAL_TEXT, '涉枪涉爆违法信息关键词.txt', 441]]) {
    assert.equal(hash(text), CATEGORY_DICTIONARY_SOURCE.sha256[filename]);
    assert.equal(categoryWords(text).length, count);
  }
  assert.equal(hash(TAGGED_POLITICAL_TEXT), POLITICAL_DICTIONARY_SOURCE.sha256.politicalText);
  assert.equal(categoryWords(TAGGED_POLITICAL_TEXT).length, 2029);
  assert.equal(POLITICAL_DICTIONARY_SOURCE.count, 2029);
  for (const [file, expected] of [['NAME-CATEGORIES-LICENSE.txt', CATEGORY_DICTIONARY_SOURCE.sha256.LICENSE],
    ['NAME-POLITICAL-LICENSE.txt', POLITICAL_DICTIONARY_SOURCE.sha256.license]]) {
    const license = readFileSync(new URL('deploy/stardust/auth/' + file, ROOT));
    assert.equal(hash(license), expected);
    assert.match(license.toString(), /Apache License/);
  }
});

test('political categories are intact, including current topics and normalized separator variants', () => {
  for (const word of politicalWords) assert.equal(moderateName(word).reason, 'sensitive', 'every upstream political entry is rejected');
  for (const word of ['习近平', '共产党', '法轮功', '台独', '新疆独立']) {
    assert.ok(politicalWords.includes(word), 'regression case comes from pinned source, not an invented term');
    for (const variant of [word, [...word].join('​'), [...word].join(' . '), [...word].join('😀'), '博士' + word, word + '01']) {
      assert.equal(moderateName(variant).reason, 'sensitive', 'political variant is rejected without echoing its value');
    }
  }
  const latin = politicalWords.find(word => /[!-~]/.test(word) && word.length <= NAME_MAX_LEN);
  assert.ok(latin, 'source includes a compatibility-width regression case');
  const fullwidth = latin.replace(/[!-~]/g, character => String.fromCharCode(character.charCodeAt(0) + 0xfee0));
  assert.equal(moderateName(fullwidth).reason, 'sensitive');
  const sample = politicalWords[0];
  const protectedPolicy = createNamePolicy({ english: [], chinese: [], political: [sample], extraEnglish: [], extraChinese: [],
    ignoredChinese: [sample], ignoredEnglish: [sample] });
  assert.equal(protectedPolicy(sample).reason, 'sensitive', 'non-political exceptions cannot override political category');
});

test('pinned upstream native dictionaries retain exact hashes, counts, and attribution', () => {
  const hash = text => createHash('sha256').update(text).digest('hex');
  assert.equal(NAME_DICTIONARY_SOURCE.revision, '5faf2ba42d7b1c0977169ec3611df25a3c08eb13');
  assert.equal(NAME_DICTIONARY_SOURCE.license, 'CC-BY-4.0');
  assert.equal(hash(ENGLISH_TEXT), NAME_DICTIONARY_SOURCE.sha256.en);
  assert.equal(hash(CHINESE_TEXT), NAME_DICTIONARY_SOURCE.sha256.zh);
  assert.equal(ENGLISH_TEXT.trimEnd().split('\n').length, 403);
  assert.equal(CHINESE_TEXT.trimEnd().split('\n').length, 319);
  const license = readFileSync(new URL('deploy/stardust/auth/NAME-DICTIONARY-LICENSE.txt', ROOT));
  assert.equal(hash(license), NAME_DICTIONARY_SOURCE.sha256.LICENSE);
  assert.match(license.toString(), /Creative Commons Attribution 4.0 International Public License/);
  assert.strictEqual(moderateName, authPolicy, 'auth/game use the same function, not copied dictionaries');
  assert.equal(NAME_POLICY_LIMITS.nameLength, NAME_MAX_LEN);
});

test('normal operators, Chinese names, punctuation, emoji and neutral identities remain usable', () => {
  for (const name of ['阿米娅', '凯尔希', '艾雅法拉', '银灰', '能天使', '史尔特尔', '斯卡蒂', '假日威龙陈',
    'W', 'Amiya', 'Texas', 'Exusiai', 'Logos', 'Hellagur', 'Executor', 'Manticore', 'SilverAsh',
    '博士 Doctor', '猫猫-01', 'Dr.博士', '😀猫', '剑圣☆', '习博士', '操博士', '中国博士', '日本干员', '同性恋博士', '成年人',
    '妈妈的小猫', '激情战士', 'xx', 'Lolita', 'Genitals', '私服博士', '阴部医生']) {
    assert.deepEqual(moderateName(name), { ok: true, name });
  }
  assert.deepEqual(moderateName(' Ａｍｉｙａ '), { ok: true, name: 'Amiya' });
  assert.deepEqual(moderateName('猫‍猫'), { ok: true, name: '猫猫' });
  const operators = JSON.parse(readFileSync(new URL('data/chess.json', ROOT), 'utf8'));
  for (const operator of Object.values(operators)) {
    if (typeof operator.name === 'string' && operator.name.length <= NAME_MAX_LEN) assert.equal(moderateName(operator.name).ok, true, 'real operator name accepted');
  }
});

test('fullwidth, case, default-ignorable, control, whitespace and punctuation obfuscation fail closed', () => {
  const variants = ['fuck', 'ＦｕＣｋ', 'FuCk', 'f​uck', 'f͏uck', 'f‮uck', 'f﻿uck', 'f\u0000uck',
    'f.u.c.k', 'f-u_c.k', 'f u c k', 'f😀u☆c_k', '傻逼', '傻​逼', '傻  .  逼', '操你妈', '操⁠你妈', '草你妈',
    '杀你全家', 'kill yourself', 'nigger', 'ＮＩＧＧＥＲ', 'n.i.g.g.e.r', 'fuck 博士', '博士-fuck', '妈妈的傻逼', '同性恋傻逼'];
  for (const name of variants) {
    assert.deepEqual(moderateName(name), { ok: false, reason: 'sensitive' }, 'obfuscated term rejected without returning a match or the name');
  }
  assert.deepEqual(moderateName('͏​‮\u0000'), { ok: false, reason: 'empty' });
  assert.deepEqual(moderateName(null), { ok: false, reason: 'invalid_type' });
  assert.deepEqual(moderateName('x'.repeat(13)), { ok: false, reason: 'too_long' });
});

test('English whole-word boundaries avoid Scunthorpe-style and punctuation-compaction false positives', () => {
  for (const name of ['Scunthorpe', 'Cass', 'cass', 'class', 'classic', 'cocktail', 'Bassist', 'assassin', 'grass', 'sex', 'sexuality']) {
    assert.equal(moderateName(name).ok, true, 'legitimate word/name remains allowed');
  }
  assert.equal(moderateName('ass').ok, false);
  assert.equal(moderateName('ass-01').ok, false);
  assert.equal(moderateName('cass-01').ok, true);
  assert.equal(moderateName('c.assio').ok, true);
  assert.equal(moderateName('assassin').ok, true);
});

test('dictionary entries are bounded literals, including regex metacharacters', () => {
  const policy = createNamePolicy({ english: ['(a+)+$', '[evil]', 'a|b'], chinese: [], political: [], extraEnglish: [], extraChinese: [] });
  for (const name of ['aaaaaa', 'evil', 'a', 'b', 'Amiya']) assert.equal(policy(name).ok, true);
  for (const name of ['(a+)+$', '[evil]', 'a|b']) assert.deepEqual(policy(name), { ok: false, reason: 'sensitive' });
  assert.deepEqual(policy('x'.repeat(2_000_000)), { ok: false, reason: 'too_long' });
  assert.deepEqual(moderateName('A' + '​'.repeat(2_000_000)), { ok: false, reason: 'too_long' });
  assert.throws(() => createNamePolicy({ english: Array(NAME_POLICY_LIMITS.dictionaryEntries + 1).fill('bounded') }), /dictionary size/);
  assert.throws(() => createNamePolicy({ english: ['x'.repeat(65)] }), /dictionary entry/);
  assert.throws(() => createNamePolicy({ chinese: [null] }), /dictionary entry/);
  const noSingleChinese = createNamePolicy({ english: [], chinese: ['习', '操'], extraEnglish: [], extraChinese: [] });
  assert.equal(noSingleChinese('习博士').ok, true);
  assert.equal(noSingleChinese('操博士').ok, true);
  assert.equal(sanitizeName('x'.repeat(2_000_000)), null);
});

test('isolated auth and both game Docker stages package only canonical moderation data', async t => {
  const gameDocker = readFileSync(new URL('Dockerfile', ROOT), 'utf8');
  const authDocker = readFileSync(new URL('deploy/stardust/auth/Dockerfile', ROOT), 'utf8');
  const offlineDocker = readFileSync(new URL('deploy/stardust/Dockerfile.offline', ROOT), 'utf8');
  for (const file of MODERATION_FILES) {
    assert.ok(gameDocker.includes('deploy/stardust/auth/' + file));
    assert.ok(authDocker.includes(file));
    assert.ok(offlineDocker.includes(file), 'offline export checks every engine/data/license file');
  }
  assert.match(gameDocker, /COPY --from=build \/app\/deploy\/stardust\/auth/);
  assert.doesNotMatch(authDocker, /COPY (?:\.\.\/|data\/|shared\/|server\/)/);
  const stage = mkdtempSync(join(tmpdir(), 'sp-name-package-'));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const auth = join(stage, 'deploy/stardust/auth');
  mkdirSync(auth, { recursive: true }); mkdirSync(join(stage, 'shared'));
  writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
  for (const file of ['server.mjs', ...MODERATION_FILES]) cpSync(new URL('deploy/stardust/auth/' + file, ROOT), join(auth, file));
  cpSync(new URL('shared/names.js', ROOT), join(stage, 'shared/names.js'));
  const stagedAuth = await import(pathToFileURL(join(auth, 'server.mjs')).href);
  const stagedGame = await import(pathToFileURL(join(stage, 'shared/names.js')).href);
  assert.equal(typeof stagedAuth.createGate, 'function');
  assert.deepEqual(stagedGame.moderateName('阿米娅'), { ok: true, name: '阿米娅' });
  assert.deepEqual(stagedGame.moderateName('ＦＵＣＫ'), { ok: false, reason: 'sensitive' });
});

test('auth login and remembered profile reject political category names without issuing or replacing identity', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'sp-name-auth-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  writeFileSync(join(fixture, 'login.html'), '<input name="csrf" value="{{CSRF}}">');
  for (const file of ['gate.css', 'gate.js', 'warmup.js', 'terminal-motion.js', 'scene.js', 'entry-nav.js', 'three.module.js', 'three.core.js', 'css3d.js', 'bender-regular.woff2']) {
    writeFileSync(join(fixture, file), 'fixture');
  }
  const password = 'test-only-name-policy-access-93';
  const secrets = await makeSecrets(password);
  const server = createGate({ secrets, publicDir: fixture });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Node24 fetch intentionally discards an overridden Host; the local proxy fixture needs real HTTP headers.
  const request = (path, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const encoded = body?.toString();
    const req = http.request(base + path, { method, headers: { Host: new URL(ORIGIN).host, ...headers,
      ...(encoded != null ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(encoded) } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString(), responseHeaders = new Headers();
        for (const [key, values] of Object.entries(res.headers)) for (const value of [values].flat()) if (value != null) responseHeaders.append(key, value);
        resolve({ status: res.statusCode, headers: responseHeaders, text: async () => text, json: async () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject); req.end(encoded);
  });
  const page = await request('/login');
  assert.equal(page.status, 200);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const csrfCookie = page.headers.get('set-cookie').split(';')[0];
  const post = (path, cookie, callsign) => request(path, { method: 'POST', headers: {
    Origin: ORIGIN, Accept: 'application/json', Cookie: cookie }, body: new URLSearchParams({ csrf, password, callsign, next: '/' }) });
  const term = politicalWords.find(word => word.length <= NAME_MAX_LEN);
  const badLogin = await post('/_gate/login', csrfCookie, [...term].join('​'));
  assert.equal(badLogin.status, 400);
  assert.equal(badLogin.headers.get('set-cookie'), null);
  assert.deepEqual(await badLogin.json(), { ok: false, message: '代号含有不适宜内容，请换一个昵称。', code: 'NAME_REJECTED', reason: 'sensitive' });
  assert.equal((await request('/check')).status, 401);
  const sessionCookie = SESSION_COOKIE + '=' + signToken('session', validateSecrets(secrets).signingKey);
  const remembered = csrfCookie + '; ' + sessionCookie;
  const badProfile = await post('/_gate/profile', remembered, [...term].join('.'));
  assert.equal(badProfile.status, 400);
  assert.equal(badProfile.headers.get('set-cookie'), null);
  assert.equal((await badProfile.json()).reason, 'sensitive');
  assert.equal((await request('/check', { headers: { Cookie: remembered } })).status, 204);
  const repaired = await post('/_gate/profile', remembered, '阿米娅');
  assert.equal(repaired.status, 200);
  assert.equal((await repaired.json()).callsign, '阿米娅');
});

async function startNetwork(t) {
  const registry = new SessionRegistry();
  const publicNames = [], logs = [], clients = [];
  const network = new Network({ registry, handler: { onMessage() {}, onHello(session) { publicNames.push(session.name); } },
    log: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(key => [key, (...args) => logs.push(args)])) });
  const server = http.createServer();
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all(clients.map(client => client.terminate()));
    network.close();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const connect = async () => {
    const client = await TestClient.connect(`ws://127.0.0.1:${server.address().port}`);
    clients.push(client); return client;
  };
  return { registry, network, publicNames, logs, connect };
}

test('real WebSocket repeated/reconnect rejected hellos cannot rename, seize or publicly echo a session', async t => {
  const { registry, publicNames, logs, connect } = await startNetwork(t);
  const owner = await connect();
  const welcome = await owner.hello('阿米娅');
  const session = registry.byId(welcome.playerId), oldSocket = session.ws;
  session.roomCode = 'ABCD';
  const repeated = await owner.request({ t: 'hello', name: 'ＦＵＣＫ' });
  assert.equal(repeated.code, ERR.NAME_REJECTED);
  assert.equal(repeated.detail, 'sensitive');
  assert.equal(Object.hasOwn(repeated, 'name'), false);
  assert.equal(session.name, '阿米娅');
  assert.equal(session.token, welcome.token);
  assert.equal(session.roomCode, 'ABCD');
  const contender = await connect();
  const rejected = await contender.request({ t: 'hello', name: '傻​逼', token: welcome.token });
  assert.equal(rejected.code, ERR.NAME_REJECTED);
  assert.strictEqual(session.ws, oldSocket);
  assert.equal(owner.isOpen, true);
  assert.equal((await owner.request({ t: 'ping', c: 1 })).t, 'pong');
  assert.equal(registry.size, 1);
  assert.deepEqual(publicNames, ['阿米娅']);
  assert.deepEqual(logs, []);
  const resumed = await contender.hello('凯尔希', welcome.token);
  assert.equal(resumed.playerId, welcome.playerId);
  assert.equal(resumed.token, welcome.token);
  assert.equal(resumed.resumed, true);
  assert.equal(session.roomCode, 'ABCD');
  assert.equal((await owner.closed).code, 4001);
  assert.deepEqual(publicNames, ['阿米娅', '凯尔希']);
});

test('real WebSocket political rejection preserves the connected identity and never publishes rejected values', async t => {
  const { registry, publicNames, logs, connect } = await startNetwork(t);
  const owner = await connect(), welcome = await owner.hello('Amiya');
  const session = registry.byId(welcome.playerId), socket = session.ws;
  const term = politicalWords.find(word => word.length >= 2 && word.length <= 5);
  const challenger = await connect();
  const rejected = await challenger.request({ t: 'hello', token: welcome.token, name: [...term].join('.') });
  assert.equal(rejected.code, ERR.NAME_REJECTED);
  assert.equal(rejected.detail, 'sensitive');
  assert.equal(Object.hasOwn(rejected, 'name'), false);
  assert.strictEqual(session.ws, socket);
  assert.equal(session.name, 'Amiya');
  assert.equal(session.token, welcome.token);
  assert.deepEqual(publicNames, ['Amiya']);
  assert.deepEqual(logs, []);
  const repaired = await challenger.hello('凯尔希', welcome.token);
  assert.equal(repaired.playerId, welcome.playerId);
  assert.equal(repaired.resumed, true);
});

test('invalid legacy name keeps its disconnected session until an explicit valid-name resume', async t => {
  const { registry, publicNames, connect } = await startNetwork(t);
  const legacy = registry.create('fuck'); // Emulates an existing session minted before moderation.
  legacy.roomCode = 'ABCD';
  const client = await connect();
  const rejected = await client.request({ t: 'hello', name: legacy.name, token: legacy.token });
  assert.equal(rejected.code, ERR.NAME_REJECTED);
  assert.strictEqual(registry.byToken(legacy.token), legacy);
  assert.equal(legacy.name, 'fuck');
  assert.equal(legacy.ws, null);
  assert.equal(legacy.connected, false);
  assert.deepEqual(publicNames, []);
  const accepted = await client.hello('Amiya', legacy.token);
  assert.equal(accepted.playerId, legacy.playerId);
  assert.equal(accepted.resumed, true);
  assert.equal(legacy.name, 'Amiya');
  assert.equal(legacy.roomCode, 'ABCD');
});
