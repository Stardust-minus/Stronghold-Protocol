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
import { moderateName as authPolicy } from '../deploy/stardust/auth/name-policy.mjs';
import { NAME_DICTIONARY_SOURCE, ENGLISH_TEXT, CHINESE_TEXT } from '../deploy/stardust/auth/name-dictionary.mjs';
import { ERR, NAME_MAX_LEN } from '../shared/constants.js';
import { Network, SessionRegistry } from '../server/net.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = new URL('../', import.meta.url);

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
  const policy = createNamePolicy({ english: ['(a+)+$', '[evil]', 'a|b'], chinese: [], extraEnglish: [], extraChinese: [] });
  for (const name of ['aaaaaa', 'evil', 'a', 'b', 'Amiya']) assert.equal(policy(name).ok, true);
  for (const name of ['(a+)+$', '[evil]', 'a|b']) assert.deepEqual(policy(name), { ok: false, reason: 'sensitive' });
  assert.deepEqual(policy('x'.repeat(2_000_000)), { ok: false, reason: 'too_long' });
  assert.deepEqual(moderateName('A' + '​'.repeat(2_000_000)), { ok: false, reason: 'too_long' });
  assert.throws(() => createNamePolicy({ english: Array(3000).fill('bounded') }), /dictionary size/);
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
  for (const file of ['name-policy.mjs', 'name-dictionary.mjs', 'NAME-DICTIONARY-LICENSE.txt']) {
    assert.ok(gameDocker.includes('deploy/stardust/auth/' + file));
    assert.ok(authDocker.includes(file));
  }
  assert.match(gameDocker, /COPY --from=build \/app\/deploy\/stardust\/auth/);
  assert.doesNotMatch(authDocker, /COPY (?:\.\.\/|data\/|shared\/|server\/)/);
  const stage = mkdtempSync(join(tmpdir(), 'sp-name-package-'));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const auth = join(stage, 'deploy/stardust/auth');
  mkdirSync(auth, { recursive: true }); mkdirSync(join(stage, 'shared'));
  writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
  for (const file of ['server.mjs', 'name-policy.mjs', 'name-dictionary.mjs', 'NAME-DICTIONARY-LICENSE.txt']) cpSync(new URL('deploy/stardust/auth/' + file, ROOT), join(auth, file));
  cpSync(new URL('shared/names.js', ROOT), join(stage, 'shared/names.js'));
  const stagedAuth = await import(pathToFileURL(join(auth, 'server.mjs')).href);
  const stagedGame = await import(pathToFileURL(join(stage, 'shared/names.js')).href);
  assert.equal(typeof stagedAuth.createGate, 'function');
  assert.deepEqual(stagedGame.moderateName('阿米娅'), { ok: true, name: '阿米娅' });
  assert.deepEqual(stagedGame.moderateName('ＦＵＣＫ'), { ok: false, reason: 'sensitive' });
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
