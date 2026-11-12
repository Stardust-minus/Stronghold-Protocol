"""Where a policy drifted from a reference: python kl_drift.py --run ck.pt --ref ppo1.pt [--matches 24] [--rehearsal 0 --boss-rehearsal 3]
Plays `run` (sampled, as in training) on the ppo2 mix and, on every observation, compares it with `ref`:
KL(ref || run) per decision kind (prep / 机变 card), per round, per action type ref would pick, and how often the greedy
actions differ. CPU, torch threads capped."""
import argparse, json
from collections import defaultdict
import numpy as np
import torch
import torch.nn.functional as F
torch.set_num_threads(4)
from spenv import NodeEnv
from model import load

TYPES = ['end', 'refresh', 'level', 'freeze', 'buy', 'sell', 'reward', 'personal', 'card']
ap = argparse.ArgumentParser()
ap.add_argument('--run', required=True); ap.add_argument('--ref', required=True); ap.add_argument('--matches', type=int, default=24)
ap.add_argument('--rehearsal', type=int, default=0); ap.add_argument('--boss-rehearsal', type=int, default=None)
ap.add_argument('--configs', default='solo:ABYSS,coop4:ABYSS,solo:HARD,coop4:HARD,coop4:NORMAL'); ap.add_argument('--node', default='node')
a = ap.parse_args()
run, _ = load(a.run); ref, _ = load(a.ref); run.eval(); ref.eval()
o = {'envs': 6, 'configs': a.configs.split(','), 'seed': 3400000000, 'envSeed': 9, 'maxMatches': a.matches, 'humans': 'random',
     'legacyMates': 0.3, 'rehearsal': a.rehearsal, 'obsVersion': 3 if 'bands' in run.spec['blocks'] else 2}
if a.boss_rehearsal is not None:
    o['bossRehearsal'] = a.boss_rehearsal
env = NodeEnv(o, node=a.node)
act = env.spec['act']; bounds = np.array([act[k] for k in ('REFRESH', 'LEVEL', 'FREEZE', 'BUY', 'SELL', 'REWARD', 'PERSONAL', 'CARD')])
G0 = env.spec['blocks']['global']['offset']
acc = defaultdict(lambda: [0.0, 0, 0])  # key -> [kl sum, n, greedy disagreements]
gen = torch.Generator(); gen.manual_seed(3)
env.reset_async(); b = env.wait()
while b.n:
    ob = torch.from_numpy(np.array(b.obs)); mk = torch.from_numpy(np.array(b.mask))
    with torch.no_grad():
        lr, _ = run(ob, mk); lf, _ = ref(ob, mk)
        pr, pf = F.log_softmax(lr, 1), F.log_softmax(lf, 1)
        kl = (pf.exp() * (pf - pr)).sum(1).numpy()
        acts = torch.multinomial(pr.exp(), 1, generator=gen).squeeze(1).int().numpy()
    g_run, g_ref = lr.argmax(1).numpy(), lf.argmax(1).numpy()
    rounds = np.rint(np.array(b.obs)[:, G0] * 15).astype(int)
    types = np.searchsorted(bounds, g_ref, side='right')
    for k in range(b.n):
        d = int(g_run[k] != g_ref[k])
        for key in ('all', 'kind:' + ('prep' if b.kinds[k] == 0 else 'card'), f'round:{rounds[k]:02d}', 'refType:' + TYPES[types[k]]):
            x = acc[key]; x[0] += float(kl[k]); x[1] += 1; x[2] += d
    env.step_async(acts); b = env.wait()
env.close()
out = {k: {'kl': v[0] / v[1], 'n': v[1], 'greedyDiffers': v[2] / v[1]} for k, v in sorted(acc.items())}
print(json.dumps({'run': a.run, 'ref': a.ref, 'byKey': out}, indent=0))
