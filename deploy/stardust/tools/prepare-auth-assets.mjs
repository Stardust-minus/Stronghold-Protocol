// Rebuild ignored PRTS dependencies from the root lockfile and the already installed local font.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const three = resolve(root, 'node_modules/three');
const output = resolve(root, 'deploy/stardust/auth/public');
const license = (await readFile(resolve(three, 'LICENSE'), 'utf8')).trimEnd();
const header = `/*\n${license}\n\n*/\n`;
const font = resolve(root, 'public/fonts/bender-regular.woff2');
// Read all prerequisites before writing generated output; this command never downloads assets.
const [moduleSource, coreSource, css3dSource, fontData] = await Promise.all([
  readFile(resolve(three, 'build/three.module.js'), 'utf8'),
  readFile(resolve(three, 'build/three.core.js'), 'utf8'),
  readFile(resolve(three, 'examples/jsm/renderers/CSS3DRenderer.js'), 'utf8'),
  readFile(font),
]);
if (css3dSource.split("from 'three'").length !== 2) throw new Error('Unexpected CSS3D import; review this deployment adapter before updating');
if (!fontData.length) throw new Error('The local Bender font is empty; complete the asset setup first');
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, 'three.module.js'), header + moduleSource),
  writeFile(resolve(output, 'three.core.js'), header + coreSource),
  writeFile(resolve(output, 'css3d.js'), header + css3dSource.replace("from 'three'", "from './three.module.js'")),
  copyFile(font, resolve(output, 'bender-regular.woff2')),
]);
console.log('Prepared PRTS runtime libraries/font from local dependencies; no secrets or network access used.');
