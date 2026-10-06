// Bounded, opt-in WS compression. Credentials and unknown/control messages stay uncompressed.
const OPTIONS = Object.freeze({
  threshold: 512,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  serverMaxWindowBits: 12,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

export function resolveWsCompression(mode = 'off') {
  if (mode === 'off') return false;
  if (mode === 'on') return OPTIONS;
  throw new TypeError('SP_WS_COMPRESSION must be on or off');
}

export function isCompressibleType(type) {
  return type === 'b.snap' || type === 'b.ev' || type === 'm.field' || type === 'm.damage';
}
