// Resolve the current PRTS player metadata without reconstructing directory or basename case.
import { inflateSync } from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

export function validateSkinPng(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG');
  let offset = 8, width = 0, height = 0, depth = 0, channels = 0, interlace = 0, ended = false, palette = false, type;
  const data = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('Invalid PNG chunk integrity');
    const tag = bytes.toString('ascii', offset + 4, offset + 8);
    if (!width && tag !== 'IHDR') throw new Error('Missing PNG header');
    if (tag === 'IHDR') {
      if (width || size !== 13) throw new Error('Invalid PNG header');
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      depth = bytes[offset + 16]; type = bytes[offset + 17]; interlace = bytes[offset + 20];
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
      const depths = type === 0 ? [1, 2, 4, 8, 16] : type === 3 ? [1, 2, 4, 8] : [8, 16];
      if (!width || !height || width > 8192 || height > 8192 || !channels || !depths.includes(depth)
        || bytes[offset + 18] || bytes[offset + 19] || interlace > 1) throw new Error('Invalid PNG dimensions or encoding');
    } else if (tag === 'PLTE') palette = size > 0 && size <= 768 && size % 3 === 0;
    else if (tag === 'IDAT') data.push(bytes.subarray(offset + 8, end - 4));
    else if (tag === 'IEND') {
      if (size || end !== bytes.length) throw new Error('Invalid PNG end');
      ended = true; break;
    }
    offset = end;
  }
  if (!ended || !data.length || (type === 3 && !palette)) throw new Error('Incomplete PNG');
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    return { size: Math.ceil(w * channels * depth / 8) + 1, count: w ? h : 0 };
  });
  const expected = rows.reduce((sum, row) => sum + row.size * row.count, 0);
  if (expected > 256 * 1024 * 1024) throw new Error('PNG decoded budget exceeded');
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('Incomplete PNG pixel stream');
  let cursor = 0;
  for (const row of rows) for (let i = 0; i < row.count; i++, cursor += row.size) if (raw[cursor] > 4) throw new Error('Invalid PNG filter');
  return { width, height };
}

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const own = (object, key) => object && typeof object === 'object' && Object.hasOwn(object, key);

export function skinBattleModels(skin, metadata) {
  if (!identifier(skin?.id) || !identifier(skin.charId) || !skin.id.startsWith(skin.charId + '_')
    || typeof skin.officialId !== 'string' || skin.officialId.replace(/[@#]/g, '_') !== skin.id
    || typeof skin.name !== 'string' || !skin.name.trim()) throw new Error('Invalid bound skin identity');
  const prefix = `https://torappu.prts.wiki/assets/char_spine/${skin.charId}/`;
  if (metadata?.prefix !== prefix || !own(metadata.skin, skin.name)) throw new Error('Unmatched character-bound model metadata');
  const models = metadata.skin[skin.name];
  const front = own(models, '正面'), back = own(models, '背面'), unified = own(models, '战斗');
  if ((!front && !unified) || (unified && (front || back))) throw new Error('Missing or ambiguous battle models');
  const result = { kind: unified ? 'unified' : back ? 'front-and-back' : 'front-only', models: {} };
  for (const [side, label, folder] of unified ? [['front', '战斗', 'spine']] : [['front', '正面', 'front'], ['back', '背面', 'back']]) {
    if (!own(models, label)) continue;
    const model = models[label];
    if (!model || typeof model !== 'object' || Array.isArray(model) || Object.keys(model).some(key => key !== 'file')
      || typeof model.file !== 'string' || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(model.file)) throw new Error('Unsupported or unsafe model declaration');
    const [directory, facing, basename] = model.file.split('/');
    if (directory.toLowerCase() !== skin.id.toLowerCase() || facing !== folder || basename !== skin.id) throw new Error('Cross-skin battle model source');
    result.models[side] = { label, file: model.file, stem: basename, remote: prefix + directory + '/' + facing + '/' };
  }
  return result;
}
