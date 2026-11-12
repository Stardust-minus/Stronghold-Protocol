import { SPEnv } from './env.mjs';
for (const v of [2, 3]) {
  const e = new SPEnv({ envs: 1, configs: ['coop4:NORMAL'], seed: 1, maxMatches: 1, obsVersion: v });
  const s = e.spec(); console.log(JSON.stringify({ version: v, dataId: s.dataId, dim: s.dim, actions: s.actions, blocks: Object.keys(s.blocks).join(',') }));
  e.close();
}
