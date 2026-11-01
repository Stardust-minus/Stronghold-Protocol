// test/helpers/versionReplicaDigest.mjs — what a browser's local display replica of a version room does, in a process of
// its own: the version's files go through loadBrowserSim (the page's route: the same copies of data, config and bounds),
// the b.start spec is built and stepped, and the state digest at each b.sync tick is compared with the Worker's. As in
// test/version-browser-sim.test.js, setGameData stands in for the page's /data.js shim.
//   node test/helpers/versionReplicaDigest.mjs <version id> <input.json>   → stdout: { compared, differed, units }
// input.json: { spec, syncs: [{ tick, h }] }
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [id, file] = process.argv.slice(2);
// a bare `node --test` also loads this helper as a test file, without arguments: nothing to compare
if (!id || !file) process.exit(0);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const { getVersionData } = await import('../../server/data.js');
const data = getVersionData(id, { log: quiet });
const { officialBoundsOf } = await import('../../shared/plugins/officialBounds.js');
const { loadBrowserSim } = await import('../../public/js/battle/simLoader.js');
const { setGameData } = await import('../../server/sim/content/support/index.js');
const { stateHash } = await import('../../server/sim/syncHash.js');
const base = pathToFileURL(fileURLToPath(new URL('../../server/sim/', import.meta.url))).href;
const sim = await loadBrowserSim({ base, data, cs: 'a'.repeat(64), bounds: officialBoundsOf(data) });
setGameData(sim.raw);
const { spec, syncs } = JSON.parse(fs.readFileSync(file, 'utf8'));
const battle = sim.spec.createBattleFromSpec(spec, sim.ds, { logger: quiet, quiet: true });
let compared = 0, differed = 0;
for (const s of syncs) {
  while (!battle.finished && battle.tickCount < s.tick) battle.step();
  if (battle.tickCount !== s.tick) break;
  compared++;
  if (stateHash(battle) !== s.h) differed++;
}
process.stdout.write(JSON.stringify({ compared, differed, units: spec.players.reduce((n, p) => n + (p.units?.length || 0), 0) }));
