// Module-only admission tests: random test-only keys and synthetic claims.
// Boolean credential assertions ensure failures never print a full token or key.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createTicketAuthority } from '../server/cluster/tickets.js';

const CLAIM_KEYS = ['sessionId', 'roomCode', 'assignmentId', 'nodeId', 'role', 'build', 'protocol'];
const PAYLOAD_KEYS = ['v', 'iss', 'iat', 'exp', 'jti', ...CLAIM_KEYS];
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CLAIMS = Object.freeze({
  sessionId: 'synthetic_session-1', roomCode: 'ABCD', assignmentId: 'synthetic_assignment:7',
  nodeId: 'synthetic_node-1', role: 'player', build: 'synthetic-build_0.1.4', protocol: 1,
});

function fixture(options = {}) {
  const key = randomBytes(32); // Generated solely for this local test; never a real deployment key.
  const clock = { time: 1_800_000_000_000 };
  const authority = createTicketAuthority({ key, now: () => clock.time, ...options });
  return { key, clock, authority, token: () => authority.issue(CLAIMS) };
}

function decode(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

// Only used with fixture-generated test keys, to isolate post-MAC validation.
function signBytes(key, bytes) {
  const body = Buffer.from(bytes).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
function sign(key, payload) { return signBytes(key, JSON.stringify(payload)); }

function rejected(authority, token, expected) {
  if (arguments.length < 3) expected = CLAIMS;
  assert.ok(authority.verify(token, expected) === null, 'invalid admission is rejected (credential redacted)');
}

function invalidIssue(authority, claims) {
  let error;
  try { authority.issue(claims); } catch (caught) { error = caught; }
  assert.ok(error instanceof TypeError || error instanceof RangeError, 'invalid issuance fails with a redacted type/range error');
  assert.ok(error.message === 'Invalid ticket claims', 'claims are not reflected in errors');
}

function alternatePadBits(part) {
  // A canonical 32-byte signature ends in 2 zero pad bits; a 16-byte jti
  // ends in 4. Change an unused bit without changing the decoded bytes.
  const last = BASE64URL.indexOf(part.at(-1));
  assert.ok(last >= 0 && last < 63, 'synthetic base64url ending has room for a pad-bit alias');
  return part.slice(0, -1) + BASE64URL[last + 1];
}

describe('cluster ticket authority: issuance and context binding', () => {
  test('default issuer/lifetime, canonical two-part wire format and frozen results', () => {
    const f = fixture(), token = f.token(), result = f.authority.verify(token, CLAIMS);
    assert.ok(result !== null, 'valid synthetic credential verifies');
    assert.ok(Object.isFrozen(f.authority) && Object.isFrozen(result), 'authority and verified payload are frozen');
    assert.deepEqual(Object.keys(f.authority), ['issue', 'verify']);
    assert.deepEqual(Object.keys(result), PAYLOAD_KEYS);
    assert.equal(result.v, 1); assert.equal(result.iss, 'stronghold-cluster');
    assert.equal(result.iat, f.clock.time); assert.equal(result.exp, f.clock.time + 30_000);
    for (const field of CLAIM_KEYS) assert.equal(result[field], CLAIMS[field], field);
    assert.ok(typeof token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token), 'token has the canonical bounded wire shape');
    assert.ok(Buffer.byteLength(token) <= 4096, 'ticket fits the wire byte limit');
    assert.ok(typeof result.jti === 'string' && /^[A-Za-z0-9_-]{22}$/.test(result.jti), 'jti is a bounded random identifier');
    const reordered = Object.fromEntries([...CLAIM_KEYS].reverse().map((field) => [field, CLAIMS[field]]));
    const next = f.authority.issue(reordered), nextResult = f.authority.verify(next, reordered);
    assert.ok(nextResult !== null && nextResult.jti !== result.jti && next !== token, 'each issue generates a distinct in-memory credential');
    assert.deepEqual(Object.keys(decode(next)), PAYLOAD_KEYS, 'claim insertion order does not alter the canonical wire order');
    assert.throws(() => { result.nodeId = 'changed'; }, TypeError);
    assert.equal(result.nodeId, CLAIMS.nodeId);
  });

  test('default Date.now clock and both supported roles', () => {
    const authority = createTicketAuthority({ key: randomBytes(32) });
    for (const role of ['player', 'spectator']) {
      const claims = { ...CLAIMS, role }, before = Date.now(), token = authority.issue(claims), after = Date.now();
      const result = authority.verify(token, claims);
      assert.ok(result !== null && result.iat >= before && result.iat <= after, 'default clock uses millisecond wall time');
      assert.equal(result.role, role);
    }
  });

  test('copied >=32-byte key is stable after caller mutation', () => {
    const key = randomBytes(64), authority = createTicketAuthority({ key, now: () => 1000 });
    const token = authority.issue(CLAIMS);
    key.fill(0);
    assert.ok(authority.verify(token, CLAIMS) !== null, 'caller key mutation cannot change this authority');
    rejected(createTicketAuthority({ key, now: () => 1000 }), token);
  });

  test('wrong key and issuer reject; matching independent authority verifies', () => {
    const f = fixture({ issuer: 'synthetic-cluster' }), token = f.token();
    rejected(createTicketAuthority({ key: randomBytes(32), issuer: 'synthetic-cluster', now: () => f.clock.time }), token);
    rejected(createTicketAuthority({ key: f.key, now: () => f.clock.time }), token);
    const peer = createTicketAuthority({ key: Buffer.from(f.key), issuer: 'synthetic-cluster', now: () => f.clock.time });
    assert.ok(peer.verify(token, CLAIMS) !== null, 'same key/issuer verify across authorities');
  });

  test('every expected field is mandatory and must match exactly', () => {
    const f = fixture(), token = f.token();
    const changes = { sessionId: 'different-session', roomCode: 'WXYZ', assignmentId: 'different-assignment',
      nodeId: 'different-node', role: 'spectator', build: 'different-build', protocol: 2 };
    for (const field of CLAIM_KEYS) {
      rejected(f.authority, token, { ...CLAIMS, [field]: changes[field] });
      const missing = { ...CLAIMS }; delete missing[field];
      rejected(f.authority, token, missing);
    }
    for (const expected of [undefined, null, {}, [], 'context', { ...CLAIMS, extra: true },
      { ...CLAIMS, protocol: '1' }, Object.assign(Object.create(null), CLAIMS), Object.create(CLAIMS)]) {
      rejected(f.authority, token, expected);
    }
    assert.ok(f.authority.verify(token) === null, 'omitting context never produces a generic credential verifier');
    const copy = { ...CLAIMS }, result = f.authority.verify(token, copy);
    copy.nodeId = 'changed-after-verification';
    assert.ok(result !== null && result.nodeId === CLAIMS.nodeId, 'verified results are independent of caller input');
  });

  test('stateless verification does not claim replay prevention or revocation', () => {
    const f = fixture(), token = f.token();
    assert.ok(f.authority.verify(token, CLAIMS) !== null && f.authority.verify(token, CLAIMS) !== null,
      'replay/epoch revocation must be enforced by the caller ledger');
  });
});

describe('cluster tickets: exact millisecond time boundaries', () => {
  test('iat is accepted, exp-1 accepted, exp and later rejected with zero clock skew', () => {
    const f = fixture(), token = f.token(), issued = f.clock.time;
    assert.ok(f.authority.verify(token, CLAIMS) !== null, 'the exact issuance time is valid');
    f.clock.time = issued - 1; rejected(f.authority, token);
    f.clock.time = issued + 29_999;
    assert.ok(f.authority.verify(token, CLAIMS) !== null, 'the final millisecond before expiry is valid');
    f.clock.time = issued + 30_000; rejected(f.authority, token);
    f.clock.time++; rejected(f.authority, token);
  });

  test('custom lifetime of one millisecond and timestamp zero are valid', () => {
    const f = fixture({ ttlMs: 1 }); f.clock.time = 0;
    const token = f.token(), result = f.authority.verify(token, CLAIMS);
    assert.ok(result !== null, 'zero is a valid timestamp');
    assert.equal(result.iat, 0); assert.equal(result.exp, 1);
    f.clock.time = 1; rejected(f.authority, token);
  });

  test('authenticated future timestamps and invalid lifetime relations reject', () => {
    const f = fixture(), payload = decode(f.token());
    const mutations = [
      { iat: f.clock.time + 1, exp: f.clock.time + 30_001 },
      { iat: f.clock.time - 30_000, exp: f.clock.time },
      { iat: payload.iat, exp: payload.iat }, { exp: payload.iat - 1 },
      { exp: payload.iat + 30_001 }, { iat: -1 }, { iat: 1.5 }, { iat: '1000' },
      { exp: '2000' }, { exp: Number.MAX_SAFE_INTEGER + 1 }, { exp: null },
    ];
    for (const changes of mutations) rejected(f.authority, sign(f.key, { ...payload, ...changes }));
    const receiver = createTicketAuthority({ key: f.key, now: () => f.clock.time, ttlMs: 10_000 });
    rejected(receiver, f.token());
  });

  test('bad/throwing clock fails closed, and issue errors do not reflect clock exceptions', () => {
    const f = fixture(), token = f.token();
    for (const time of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null, undefined, 1n]) {
      f.clock.time = time;
      rejected(f.authority, token);
      assert.throws(() => f.token(), (error) => error instanceof TypeError || error instanceof RangeError);
    }
    const marker = 'synthetic-sensitive-clock-marker';
    const authority = createTicketAuthority({ key: f.key, now: () => { throw new Error(marker); } });
    rejected(authority, token);
    assert.throws(() => authority.issue(CLAIMS), (error) => error instanceof TypeError && !error.message.includes(marker));
  });

  test('safe integer expiry arithmetic never overflows', () => {
    const f = fixture({ ttlMs: 1 }); f.clock.time = Number.MAX_SAFE_INTEGER - 1;
    const token = f.token(), result = f.authority.verify(token, CLAIMS);
    assert.ok(result !== null && result.exp === Number.MAX_SAFE_INTEGER, 'largest safe expiry remains valid');
    f.clock.time = Number.MAX_SAFE_INTEGER;
    rejected(f.authority, token);
    assert.throws(() => f.token(), RangeError);
  });
});

describe('cluster tickets: strict records and bounded input', () => {
  test('configuration rejects missing/short/non-Buffer keys and invalid issuer/clock/lifetime', () => {
    const key = randomBytes(32), marker = 'synthetic-untrusted-configuration-marker';
    for (const options of [undefined, null, {}, { key: null }, { key: marker }, { key: new Uint8Array(32) }, { key: Buffer.alloc(31) },
      ...['', 'has space', 'x'.repeat(129), 1, {}, null].map((issuer) => ({ key, issuer })),
      ...[null, 1, 'Date.now', {}].map((now) => ({ key, now })),
      ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '30000', null, 1n].map((ttlMs) => ({ key, ttlMs }))]) {
      assert.throws(() => createTicketAuthority(options), (error) =>
        (error instanceof TypeError || error instanceof RangeError) && !error.message.includes(marker));
    }
  });

  test('claims require the exact whitelist, primitive field types and allowed roles', () => {
    const f = fixture();
    for (const claims of [undefined, null, [], new Date(), 'claims', 1, false, Object.create(CLAIMS),
      Object.assign(Object.create(null), CLAIMS), Object.assign(Object.create({}), CLAIMS),
      new (class Claims { constructor() { Object.assign(this, CLAIMS); } })(),
      { ...CLAIMS, extra: true }, { ...CLAIMS, v: 1 }, { ...CLAIMS, iss: 'stronghold-cluster' },
      { ...CLAIMS, [Symbol('unknown')]: true },
      JSON.parse(JSON.stringify(CLAIMS).replace('"sessionId"', '"__proto__":{},"sessionId"'))]) invalidIssue(f.authority, claims);
    for (const field of CLAIM_KEYS) {
      const claims = { ...CLAIMS }; delete claims[field]; invalidIssue(f.authority, claims);
      for (const value of [null, undefined, {}, [], true, 1n, new String('boxed')]) invalidIssue(f.authority, { ...CLAIMS, [field]: value });
    }
    for (const role of ['', 'admin', 'PLAYER', 1]) invalidIssue(f.authority, { ...CLAIMS, role });
    for (const protocol of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) invalidIssue(f.authority, { ...CLAIMS, protocol });
    const maximum = { ...CLAIMS, protocol: Number.MAX_SAFE_INTEGER };
    assert.ok(f.authority.verify(f.authority.issue(maximum), maximum) !== null, 'largest safe positive protocol is valid');
  });

  test('all identifier strings enforce safe alphabet and 1–128 bounds', () => {
    const f = fixture();
    const unsafe = ['', 'x'.repeat(129), 'x'.repeat(100_000), 'contains space', '\n', 'x\n', 'x\r', 'x\r\n',
      `x${String.fromCharCode(0x2028)}`, `x${String.fromCharCode(0x2029)}`, 'x\r\ny', 'x\0y', 'x\ty',
      '/path', 'x?token', 'x#fragment', 'x%20y',
      'x"y', 'x\\y', '测试', '\ud800', '.leading', ':leading'];
    for (const field of CLAIM_KEYS.filter((key) => key !== 'protocol' && key !== 'role')) {
      for (const value of unsafe) invalidIssue(f.authority, { ...CLAIMS, [field]: value });
    }
    for (const value of ['x', 'A'.repeat(128), '_safe-identifier:1.2']) {
      const claims = { ...CLAIMS, sessionId: value, roomCode: value, assignmentId: value, nodeId: value, build: value };
      const token = f.authority.issue(claims);
      assert.ok(Buffer.byteLength(token) <= 4096 && f.authority.verify(token, claims) !== null, 'boundary identifier lengths are valid and bounded');
    }
  });

  test('hidden keys, accessors, illegal prototypes and inspection failures reject without invoking getters', () => {
    const f = fixture(), token = f.token(), inputs = [], marker = 'synthetic-sensitive-inspection-marker';
    let getterCalls = 0;
    const accessor = { ...CLAIMS };
    Object.defineProperty(accessor, 'nodeId', { enumerable: true, get() { getterCalls++; throw new Error(marker); } });
    inputs.push(accessor);
    const hiddenExtra = { ...CLAIMS };
    Object.defineProperty(hiddenExtra, 'extra', { value: true }); inputs.push(hiddenExtra);
    const hiddenClaim = { ...CLAIMS };
    Object.defineProperty(hiddenClaim, 'nodeId', { value: CLAIMS.nodeId, enumerable: false }); inputs.push(hiddenClaim);
    inputs.push(new Proxy({ ...CLAIMS }, { getPrototypeOf() { throw new Error(marker); } }));
    inputs.push(new Proxy({ ...CLAIMS }, { ownKeys() { throw new Error(marker); } }));
    const revocable = Proxy.revocable({ ...CLAIMS }, {}); revocable.revoke(); inputs.push(revocable.proxy);
    for (const input of inputs) { invalidIssue(f.authority, input); rejected(f.authority, token, input); }
    assert.equal(getterCalls, 0, 'accessor input is rejected without executing it');
  });

  test('malformed token types and 4096-byte maximum are handled without coercion or exceptions', () => {
    const f = fixture();
    let calls = 0;
    const coercible = { toString() { calls++; throw new Error('synthetic-coercion-marker'); } };
    for (const token of [undefined, null, false, 1, 1n, [], {}, coercible, Buffer.alloc(8), new String('boxed'),
      '', '.', 'a', 'a.b', '.a', 'a.', 'a.b.c', 'a\0.b', 'a'.repeat(4096), 'a'.repeat(4097), 'a'.repeat(100_000), '测'.repeat(2000)]) {
      rejected(f.authority, token);
    }
    assert.equal(calls, 0, 'untrusted tokens are never string-coerced');
    const signedHuge = sign(f.key, { ...decode(f.token()), build: 'x'.repeat(4000) });
    assert.ok(Buffer.byteLength(signedHuge) > 4096, 'synthetic oversized test credential exceeds the limit');
    rejected(f.authority, signedHuge);
  });
});

describe('cluster tickets: authentication and canonical encodings', () => {
  test('payload/signature tampering, truncation, appending and wrong signature sizes reject', () => {
    const f = fixture(), token = f.token(), [body, signature] = token.split('.');
    const alteredSignature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    const alteredPayload = Buffer.from(JSON.stringify({ ...decode(token), nodeId: 'different-node' })).toString('base64url');
    for (const malformed of [`${body}.${alteredSignature}`, `${alteredPayload}.${signature}`, token.slice(0, -1),
      `${token}A`, `${token}.extra`, `${body}.${randomBytes(31).toString('base64url')}`,
      `${body}.${randomBytes(33).toString('base64url')}`, `${body}.${'A'.repeat(43)}`]) rejected(f.authority, malformed);
  });

  test('base64url rejects padding, whitespace, standard alphabet and nonzero unused pad bits', () => {
    const f = fixture(), token = f.token(), [body, signature] = token.split('.');
    for (const malformed of [`${body}=.${signature}`, `${body}.${signature}=`, `${body}\n.${signature}`,
      `${body}. ${signature}`, `${body}.${signature.slice(0, -1)}+`, `${body}.${signature.slice(0, -1)}/`,
      `+${body.slice(1)}.${signature}`, `/${body.slice(1)}.${signature}`, `${body}.${alternatePadBits(signature)}`]) rejected(f.authority, malformed);
    const payload = decode(token);
    // Ensure the payload itself has unused pad bits, then MAC the alias to prove
    // rejection is encoding policy rather than just a mismatched signature.
    let canonicalBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
    while (canonicalBody.length % 4 === 0) {
      payload.build += 'x'; canonicalBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
    }
    const alias = alternatePadBits(canonicalBody), aliasSignature = createHmac('sha256', f.key).update(alias).digest('base64url');
    rejected(f.authority, `${alias}.${aliasSignature}`, { ...CLAIMS, build: payload.build });
  });

  test('authenticated metadata, unknown fields, illegal types and invalid jti reject', () => {
    const f = fixture(), payload = decode(f.token());
    const mutations = [{ v: 2 }, { v: '1' }, { iss: 'different-issuer' }, { iss: null }, { extra: true },
      { role: 'admin' }, { nodeId: {} }, { protocol: '1' }, { protocol: 0 }, { protocol: Number.MAX_SAFE_INTEGER + 1 },
      { build: 'x'.repeat(129) }, { sessionId: 'unsafe\nvalue' }, { jti: null }, { jti: '' },
      { jti: 'A'.repeat(21) }, { jti: 'A'.repeat(23) }, { jti: 'A'.repeat(21) + '+' },
      { jti: payload.jti + '=' }, { jti: alternatePadBits(payload.jti) }];
    for (const changes of mutations) rejected(f.authority, sign(f.key, { ...payload, ...changes }));
    for (const field of PAYLOAD_KEYS) {
      const missing = { ...payload }; delete missing[field];
      rejected(f.authority, sign(f.key, missing));
    }
    const protoKey = JSON.stringify(payload).replace('"v":1', '"v":1,"__proto__":{}');
    rejected(f.authority, signBytes(f.key, protoKey));
  });

  test('authenticated malformed JSON/UTF-8, whitespace, duplicates and noncanonical ordering reject', () => {
    const f = fixture(), payload = decode(f.token()), raw = JSON.stringify(payload);
    const reversed = Object.fromEntries([...PAYLOAD_KEYS].reverse().map((field) => [field, payload[field]]));
    for (const bytes of ['{', 'null', '[]', '1', '"text"', `${raw}\n`, JSON.stringify(payload, null, 2),
      JSON.stringify(reversed), raw.replace('"v":1', '"v":1,"v":1'), raw.replace('"protocol":1', '"protocol":1e0'),
      raw.replace('synthetic_session-1', '\\u0073ynthetic_session-1'), Buffer.from([0xff, 0xfe, 0x7b, 0x7d])]) {
      rejected(f.authority, signBytes(f.key, bytes));
    }
  });
});
