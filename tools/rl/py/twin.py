"""Label ambiguity in the bc1 data (inference only, CPU): python twin.py --data <dataId dir> --ckpt probe/a-s1.pt
Two legal slot actions whose observation rows are identical (same card, price, flags; the encoding has no slot index) get
the same logit, and the teacher picks one of them: raw accuracy caps at 1/2 there. Classes: slot actions with identical
rows (shop, owned, rewards, personal, cards), each scalar action alone. Reports per action group: twin rate (the label
has an identical legal sibling), raw / class accuracy, raw / class cross-entropy (−log Σ_class π)."""
import argparse, json
import numpy as np
import torch
import torch.nn.functional as F
torch.set_num_threads(2)
from data import load_shards, unpack_mask
from model import load

GROUPS = {'scalar': (0, 4), 'buy': (4, 14), 'sell': (14, 41), 'reward': (41, 47), 'personal': (47, 52), 'card': (52, 60)}
ap = argparse.ArgumentParser(); ap.add_argument('--data', required=True); ap.add_argument('--ckpt', required=True)
ap.add_argument('--val-every', type=int, default=20); ap.add_argument('--limit', type=int, default=0)
a = ap.parse_args()
shards = load_shards(a.data, 0.997)
spec = shards[0][1]['spec']; A = spec['actions']; blocks = spec['blocks']
val = [s for i, s in enumerate(shards) if i % a.val_every == a.val_every - 1]
obs = np.concatenate([np.asarray(s[2]['obs']) for s in val]); mask = np.concatenate([unpack_mask(np.asarray(s[2]['mask']), A) for s in val])
act = np.concatenate([np.asarray(s[2]['action']).astype(np.int64) for s in val])
if a.limit:
    obs, mask, act = obs[:a.limit], mask[:a.limit], act[:a.limit]
N = len(act)
# class id of every action: scalar actions -> own id; slot actions -> (block, exact row projection)
rng = np.random.default_rng(0)
cls = np.zeros((N, A), dtype=np.float64)
spans = [('shop', 4), ('owned', 14), ('rewards', 41), ('personal', 47), ('cards', 52)]
for a_ in range(4):
    cls[:, a_] = -(a_ + 1)
for bi, (name, start) in enumerate(spans):
    b = blocks[name]; w = b['width']; proj = rng.standard_normal(w)
    rows = obs[:, b['offset']:b['offset'] + b['count'] * w].astype(np.float64).reshape(N, b['count'], w)
    cls[:, start:start + b['count']] = rows @ proj + 1e6 * (bi + 1)
net, _ = load(a.ckpt); net.eval()
out = {g: dict(n=0, twin=0, raw=0, cl=0, ce=0.0, cce=0.0) for g in list(GROUPS) + ['all']}
for i in range(0, N, 4096):
    o = torch.from_numpy(obs[i:i + 4096]).float(); m = torch.from_numpy(mask[i:i + 4096]); y = act[i:i + 4096]
    with torch.no_grad():
        lp = F.log_softmax(net(o, m)[0], 1).numpy()
    c = cls[i:i + 4096]; mk = mask[i:i + 4096]; idx = np.arange(len(y))
    same = (c == c[idx, y][:, None]) & mk                       # legal actions in the label's class
    twin = same.sum(1) > 1
    pred = lp.argmax(1)
    raw = pred == y; clok = same[idx, pred]
    ce = -lp[idx, y]
    cce = -np.log(np.clip((np.exp(lp) * same).sum(1), 1e-12, None))
    for g, (lo, hi) in list(GROUPS.items()) + [('all', (0, A))]:
        sel = (y >= lo) & (y < hi); x = out[g]
        x['n'] += int(sel.sum()); x['twin'] += int(twin[sel].sum()); x['raw'] += int(raw[sel].sum()); x['cl'] += int(clok[sel].sum())
        x['ce'] += float(ce[sel].sum()); x['cce'] += float(cce[sel].sum())
res = {g: {'n': x['n'], 'twinRate': x['twin'] / max(1, x['n']), 'rawAcc': x['raw'] / max(1, x['n']), 'classAcc': x['cl'] / max(1, x['n']),
           'rawCE': x['ce'] / max(1, x['n']), 'classCE': x['cce'] / max(1, x['n'])} for g, x in out.items()}
print(json.dumps({'ckpt': a.ckpt, 'val': N, 'byGroup': res}, indent=1))
