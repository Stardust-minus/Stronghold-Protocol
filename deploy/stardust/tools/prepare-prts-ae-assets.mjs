// Optional PRTS artwork; import only fixed image/OBJ inputs from the user's extracted AE project.
// No project expressions, plugins, MTL references, or executable content are loaded.
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const input = process.argv[2];
if (!input) throw new Error('Pass the extracted project folder containing ARK2086 and 素材');
const output = join(root, 'deploy/stardust/auth/public');
const sources = {
  doctor: join(resolve(input), 'ARK2086/(Footage)/Npc_doctor.png'),
  rhodes: join(resolve(input), 'ARK2086/(Footage)/logo_rhodes.png'),
  sphere: join(resolve(input), '素材/低模球体模型.obj'),
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const original = {};
for (const [name, path] of Object.entries(sources)) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid fixed AE input: ' + name);
  original[name] = await readFile(path);
}
const vertices = [], faces = [];
for (const line of original.sphere.toString('utf8').split(/\r?\n/)) {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'v') {
    const point = parts.slice(1).map(Number);
    if (point.length !== 3 || point.some(n => !Number.isFinite(n) || Math.abs(n) > 10000)) throw new Error('Invalid sphere vertex');
    vertices.push(point);
  } else if (parts[0] === 'f') {
    const face = parts.slice(1).map(s => Number(s.split('/')[0]) - 1);
    if (face.length !== 3 || face.some(n => !Number.isInteger(n) || n < 0)) throw new Error('Only positive triangular sphere faces are supported');
    faces.push(face);
  }
}
if (!vertices.length || vertices.length > 3000 || !faces.length || faces.length > 1000 || faces.flat().some(i => i >= vertices.length)) throw new Error('Unexpected sphere inventory');
const radius = Math.max(...vertices.map(v => Math.hypot(...v)));
const edges = new Map();
for (const face of faces) for (let j = 0; j < 3; j++) {
  const a = vertices[face[j]].map(n => Number((n / radius).toFixed(6)));
  const b = vertices[face[(j + 1) % 3]].map(n => Number((n / radius).toFixed(6)));
  const key = [a.join(','), b.join(',')].sort().join('|');
  edges.set(key, [...a, ...b]);
}
const sphere = { version: 1, positions: [...edges.values()].flat() };
await writeFile(join(output, 'ae-sphere.json'), JSON.stringify(sphere) + '\n');
execFileSync('magick', ['-limit', 'memory', '64MiB', '-limit', 'map', '128MiB', sources.doctor,
  '-crop', '280x460+405+16', '+repage', '-resize', '256x420', '-strip', '-quality', '88', join(output, 'doctor.webp')]);
execFileSync('magick', ['-limit', 'memory', '64MiB', '-limit', 'map', '128MiB', sources.rhodes,
  '-resize', '384x384', '-strip', '-define', 'webp:lossless=true', join(output, 'rhodes.webp')]);
const generated = {};
for (const name of ['doctor.webp', 'rhodes.webp', 'ae-sphere.json']) {
  const bytes = await readFile(join(output, name));
  generated[name] = { bytes: bytes.length, sha256: sha(bytes) };
}
console.log(JSON.stringify({ inputs: Object.fromEntries(Object.entries(original).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])),
  originalVertices: vertices.length, originalFaces: faces.length, uniqueEdges: edges.size, generated, artworkIgnored: true, expressionsExecuted: false }, null, 2));
