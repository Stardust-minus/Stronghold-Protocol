"""S5 observation surgery (ppo3): python surgery.py --ckpt old.pt --out new.pt [--node node]
Builds the network for the current environment spec (new blocks appended at the end of the observation), copies every
parameter of the old checkpoint, zero-initialises the trunk's input columns of the new blocks (their encoders keep a
random init, so they can learn), and checks on real observations that the new network's logits and values equal the old
one's. CPU only."""
import argparse
import numpy as np
import torch
torch.set_num_threads(4)
from spenv import NodeEnv, masked_random
from model import SPNet, load, save, param_count

ap = argparse.ArgumentParser(); ap.add_argument('--ckpt', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--node', default='node')
a = ap.parse_args()
old, ck = load(a.ckpt); old.eval()
env = NodeEnv({'envs': 4, 'configs': ['coop4:ABYSS', 'solo:HARD', 'coop2:NORMAL'], 'seed': 3300000000, 'maxMatches': 12, 'humans': 'random',
               'obsVersion': 3}, node=a.node)
spec = env.spec
new = SPNet(spec)
so, sn = old.state_dict(), new.state_dict()
copied, grown = 0, []
for k, v in so.items():
    if k not in sn:
        raise SystemExit(f'parameter {k} has no place in the new network')
    if sn[k].shape == v.shape:
        sn[k] = v.clone(); copied += 1
    elif k == 'trunk.0.weight' and sn[k].shape[0] == v.shape[0] and sn[k].shape[1] > v.shape[1]:
        w = torch.zeros_like(sn[k]); w[:, :v.shape[1]] = v; sn[k] = w; copied += 1; grown.append((k, tuple(v.shape), tuple(w.shape)))
    else:
        raise SystemExit(f'{k}: {tuple(v.shape)} -> {tuple(sn[k].shape)} not supported')
new.load_state_dict(sn); new.eval()
print('old params', param_count(old), 'new params', param_count(new), 'copied', copied, 'grown', grown, 'D', old.D, '->', new.D)
rng = np.random.default_rng(0); env.reset_async(); b = env.wait(); worst_l = worst_v = 0.0; rows = 0; agree = 0
while b.n and rows < 4000:
    o = torch.from_numpy(np.array(b.obs)); m = torch.from_numpy(np.array(b.mask))
    Ao = old.A  # the old network's actions are the new one's first Ao (band actions are appended)
    with torch.no_grad():
        lo, vo = old(o, m[:, :Ao]); ln, vn = new(o, m)
    legal = m[:, :Ao]
    if legal.any():
        worst_l = max(worst_l, float((ln[:, :Ao] - lo).abs()[legal].max()))
    worst_v = max(worst_v, float((vn - vo).abs().max()))
    agree += int((ln[:, :Ao].argmax(1) == lo.argmax(1)).sum()); rows += b.n
    env.step_async(masked_random(b.mask, rng)); b = env.wait()
env.close()
print(f'parity over {rows} observations: max |logit diff| (legal) {worst_l:.3g}, max |value diff| {worst_v:.3g}, argmax agree {agree / max(1, rows):.4f}')
if worst_l > 1e-5 or worst_v > 1e-5:
    raise SystemExit('parity FAILED')
save(a.out, new, {'surgery_from': a.ckpt, 'steps': ck.get('steps'), 'stage': ck.get('stage')})
print('saved', a.out, 'dataId', spec['dataId'])
