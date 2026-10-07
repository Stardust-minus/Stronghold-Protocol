// Short-lived bearer admission tickets, not encryption or an authorization policy.
// Carry tokens only in WebSocket messages or protected request bodies; never place
// them in URL queries, cookies or logs. Keep the signing key outside source/logs.
// Verification is stateless: it does NOT prevent replay or promise revocation.
// The caller's ledger must enforce idempotent admission/revocation using jti and
// the live assignment epoch (bound to assignmentId), plus current session access.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_TOKEN_BYTES = 4096;
const MAX_STRING_LENGTH = 128;
const SIGNATURE_BYTES = 32;
const CLAIM_KEYS = Object.freeze(['sessionId', 'roomCode', 'assignmentId', 'nodeId', 'role', 'build', 'protocol']);
// This order is the v1 wire format. No whitespace, alternate JSON spellings or
// alternate base64url representations are accepted, even with a valid signature.
const PAYLOAD_KEYS = Object.freeze(['v', 'iss', 'iat', 'exp', 'jti', ...CLAIM_KEYS]);
// Use a true end-of-input assertion: JS `$` also matches before a final newline.
const SAFE_STRING = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function safeString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH && SAFE_STRING.test(value);
}

// Read data descriptors, not getters; reject inherited, hidden and symbol keys.
// Inspection traps from malformed objects also fail closed without echoing them.
function exactRecord(value, fields) {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) return null;
    const record = {};
    for (const field of fields) {
      const property = Object.getOwnPropertyDescriptor(value, field);
      if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) return null;
      record[field] = property.value;
    }
    return record;
  } catch { return null; }
}

function validClaims(claims) {
  return CLAIM_KEYS.every((field) => field === 'protocol'
    ? Number.isSafeInteger(claims[field]) && claims[field] > 0
    : field === 'role' ? claims[field] === 'player' || claims[field] === 'spectator'
      : safeString(claims[field]));
}

function canonicalPayload(payload) {
  const record = {};
  for (const field of PAYLOAD_KEYS) record[field] = payload[field];
  return JSON.stringify(record);
}

function decodeCanonical(part) {
  if (!BASE64URL.test(part)) return null;
  const bytes = Buffer.from(part, 'base64url');
  return bytes.toString('base64url') === part ? bytes : null;
}

function readTime(now) {
  let time;
  try { time = now(); } catch { throw new TypeError('Ticket clock failed'); }
  if (typeof time !== 'number') throw new TypeError('Ticket clock must return milliseconds');
  if (!Number.isSafeInteger(time) || time < 0) throw new RangeError('Ticket clock must return nonnegative safe integer milliseconds');
  return time;
}

/**
 * Strings are 1–128 ASCII identifier characters: [A-Za-z0-9_-][A-Za-z0-9_.:-]*.
 * Claims and expected require all seven own enumerable data fields, no extras,
 * and Object.prototype (not null/custom/class prototypes). Times are integer ms.
 * Future-clock tolerance defaults to zero; private peers can allow up to 2000ms
 * of issuer clock skew. Expiry remains strict (now < exp), lifetime <= ttlMs.
 * issue returns a token string; verify returns the frozen v1 payload or null.
 */
export function createTicketAuthority({ key, issuer = 'stronghold-cluster', now = Date.now, ttlMs = 30000, futureSkewMs = 0 }) {
  if (!Buffer.isBuffer(key)) throw new TypeError('Ticket key must be a Buffer');
  if (key.length < SIGNATURE_BYTES) throw new RangeError('Ticket key must contain at least 32 bytes');
  if (!safeString(issuer)) throw new TypeError('Ticket issuer must be a bounded safe identifier');
  if (typeof now !== 'function') throw new TypeError('Ticket clock must be a function');
  if (typeof ttlMs !== 'number') throw new TypeError('Ticket lifetime must be milliseconds');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('Ticket lifetime must be a positive safe integer');
  if (!Number.isSafeInteger(futureSkewMs) || futureSkewMs < 0 || futureSkewMs > 2000) throw new RangeError('Invalid ticket future clock allowance');
  // A caller mutating/reusing its Buffer cannot silently rotate this authority.
  const signingKey = Buffer.from(key);

  function issue(claims) {
    const context = exactRecord(claims, CLAIM_KEYS);
    if (!context || !validClaims(context)) throw new TypeError('Invalid ticket claims');
    const iat = readTime(now), exp = iat + ttlMs;
    if (!Number.isSafeInteger(exp)) throw new RangeError('Ticket expiry exceeds safe integer milliseconds');
    const payload = { v: 1, iss: issuer, iat, exp, jti: randomBytes(16).toString('base64url'), ...context };
    const body = Buffer.from(canonicalPayload(payload)).toString('base64url');
    const signature = createHmac('sha256', signingKey).update(body).digest('base64url');
    const token = `${body}.${signature}`;
    if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new RangeError('Ticket exceeds the size limit');
    return token;
  }

  function verify(token, expected) {
    try {
      // The alphabet checks below make accepted tokens ASCII, so this length
      // check also bounds byte length before allocating any decoded buffers.
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) return null;
      const separator = token.indexOf('.');
      if (separator <= 0 || separator !== token.lastIndexOf('.')) return null;
      const body = token.slice(0, separator), signature = token.slice(separator + 1);
      if (signature.length !== 43) return null;
      const signatureBytes = decodeCanonical(signature), payloadBytes = decodeCanonical(body);
      if (!signatureBytes || signatureBytes.length !== SIGNATURE_BYTES || !payloadBytes) return null;
      const digest = createHmac('sha256', signingKey).update(body).digest();
      // Always compare exactly 32 bytes; unequal-sized input never reaches this.
      if (!timingSafeEqual(signatureBytes, digest)) return null;

      const payload = exactRecord(JSON.parse(payloadBytes.toString('utf8')), PAYLOAD_KEYS);
      if (!payload || !validClaims(payload) || payload.v !== 1 || payload.iss !== issuer) return null;
      if (!Number.isSafeInteger(payload.iat) || payload.iat < 0 || !Number.isSafeInteger(payload.exp)
        || payload.exp <= payload.iat || payload.exp - payload.iat > ttlMs) return null;
      if (typeof payload.jti !== 'string' || payload.jti.length !== 22 || decodeCanonical(payload.jti)?.length !== 16) return null;
      if (Buffer.from(canonicalPayload(payload)).toString('base64url') !== body) return null;

      const context = exactRecord(expected, CLAIM_KEYS);
      if (!context || !validClaims(context) || CLAIM_KEYS.some((field) => context[field] !== payload[field])) return null;
      const time = readTime(now);
      if (payload.iat - time > futureSkewMs || payload.exp <= time) return null;
      return Object.freeze(payload);
    } catch { return null; }
  }

  return Object.freeze({ issue, verify });
}
