// tools/simClosure.mjs — the modules a browser loads to simulate a battle (DESIGN §14; the consensus design's
// determinism audit): every server/sim module but the Node-only data loader, and everything they import — relative
// specifiers, static and literal dynamic imports — except server/data.js (the browser is served the /data.js shim in
// its place). The determinism guards cover this whole set, not only server/sim/: eslint.config.js (the approximated
// Math functions, `**`) and test/sim/detmath.test.js (the same scan, plus clocks, Math.random, locale collation).
//
//   simClosure(root?) → repo-relative paths ('/'-separated), sorted
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Never run by a browser's simulation: the Node data loader and the server's data singleton (a shim in the browser). */
export const SIM_NODE_ONLY = Object.freeze(['server/sim/nodeData.js', 'server/data.js']);
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** @param {string} [root] @returns {string[]} */
export function simClosure(root = ROOT) {
  const rel = (f) => relative(root, f).split('\\').join('/');
  const skip = new Set(SIM_NODE_ONLY);
  const stack = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !skip.has(rel(p))) stack.push(p);
    }
  };
  walk(join(root, 'server/sim'));
  const seen = new Set();
  while (stack.length) { // loop-cap: each file enters `seen` once
    const f = stack.pop();
    if (seen.has(f) || skip.has(rel(f)) || !existsSync(f) || !statSync(f).isFile()) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith('.')) stack.push(resolve(dirname(f), spec));
    }
  }
  return [...seen].map(rel).sort();
}
