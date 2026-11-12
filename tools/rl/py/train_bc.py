"""Behaviour cloning of the rule-enforcing legacy teacher (plan §8.9, B2):
python train_bc.py --data data/<dataId> --out runs/bc-<name> [--epochs 4]"""
import argparse, json, math, os, time
import numpy as np
import torch
import torch.nn.functional as F
from data import load_shards, unpack_mask
from model import SPNet, param_count, save
torch.set_num_threads(4)  # helpers never take the whole CPU set

ap = argparse.ArgumentParser()
ap.add_argument('--data', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--epochs', type=int, default=4)
ap.add_argument('--batch', type=int, default=4096)
ap.add_argument('--lr', type=float, default=1e-3)
ap.add_argument('--vf', type=float, default=0.5)
ap.add_argument('--gamma', type=float, default=0.997)
ap.add_argument('--val-every', type=int, default=20, help='every n-th shard is validation')
ap.add_argument('--max-train', type=int, default=0)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
dev = torch.device('cuda')
log = open(os.path.join(a.out, 'bc-log.jsonl'), 'a')
def emit(**kw):
    kw['t'] = round(time.time(), 1); print(json.dumps(kw), flush=True); log.write(json.dumps(kw) + '\n'); log.flush()

t0 = time.time()
shards = load_shards(a.data, a.gamma)
spec = shards[0][1]['spec']
A = spec['actions']
def stack(sel):
    obs = np.concatenate([np.asarray(s[2]['obs']) for s in sel])
    mask = np.concatenate([unpack_mask(np.asarray(s[2]['mask']), A) for s in sel])
    act = np.concatenate([np.asarray(s[2]['action']).astype(np.int64) for s in sel])
    kind = np.concatenate([np.asarray(s[2]['kind']).astype(np.int64) for s in sel])
    ret = np.concatenate([s[3] for s in sel])
    return obs, mask, act, kind, ret
val_sel = [s for i, s in enumerate(shards) if i % a.val_every == a.val_every - 1] or shards[-1:]
train_sel = [s for s in shards if s not in val_sel] or shards
tr, va = stack(train_sel), stack(val_sel)
if a.max_train and len(tr[0]) > a.max_train:
    tr = tuple(x[:a.max_train] for x in tr)
emit(event='data', train=len(tr[0]), val=len(va[0]), shards=len(shards), load_s=round(time.time() - t0, 1),
     ret_mean=float(tr[4].mean()), ret_std=float(tr[4].std()))
def to_gpu(x):
    obs, mask, act, kind, ret = x
    return (torch.from_numpy(obs).to(dev), torch.from_numpy(mask).to(dev), torch.from_numpy(act).to(dev),
            torch.from_numpy(kind).to(dev), torch.from_numpy(ret).to(dev))
TR, VA = to_gpu(tr), to_gpu(va)
del tr, va
net = SPNet(spec).to(dev)
emit(event='model', params=param_count(net))
opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-5)
N = TR[0].shape[0]
steps_total = a.epochs * math.ceil(N / a.batch)
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps_total))))
act_groups = {'scalar': (0, 4), 'buy': (4, 14), 'sell': (14, 41), 'reward': (41, 47), 'personal': (47, 52), 'card': (52, 60)}

@torch.no_grad()
def evaluate(D):
    net.eval()
    ce = vl = 0.0; correct = 0; n = 0
    by_group = {k: [0, 0] for k in act_groups}
    for i in range(0, D[0].shape[0], 8192):
        obs, mask, act, kind, ret = (x[i:i + 8192] for x in D)
        logits, v = net(obs.float(), mask)
        ce += F.cross_entropy(logits, act, reduction='sum').item(); vl += F.mse_loss(v, ret, reduction='sum').item()
        pred = logits.argmax(1); ok = pred == act
        correct += ok.sum().item(); n += len(act)
        for k, (lo, hi) in act_groups.items():
            sel = (act >= lo) & (act < hi)
            by_group[k][0] += ok[sel].sum().item(); by_group[k][1] += sel.sum().item()
    net.train()
    return {'ce': ce / n, 'acc': correct / n, 'vmse': vl / n, 'acc_by': {k: round(c / t, 4) if t else None for k, (c, t) in by_group.items()},
            'share_by': {k: round(t / n, 4) for k, (c, t) in by_group.items()}}

best = math.inf; step = 0
for ep in range(a.epochs):
    perm = torch.randperm(N, device=dev)
    for i in range(0, N, a.batch):
        idx = perm[i:i + a.batch]
        obs, mask, act, kind, ret = (x[idx] for x in TR)
        logits, v = net(obs.float(), mask)
        pl = F.cross_entropy(logits, act); vl = F.mse_loss(v, ret)
        loss = pl + a.vf * vl
        opt.zero_grad(set_to_none=True); loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0); opt.step(); sched.step(); step += 1
        if step % 200 == 0:
            emit(event='train', epoch=ep, step=step, ce=round(pl.item(), 4), vmse=round(vl.item(), 4), lr=sched.get_last_lr()[0])
    m = evaluate(VA)
    emit(event='val', epoch=ep, step=step, **m)
    if m['ce'] < best:
        best = m['ce']; save(os.path.join(a.out, 'bc.pt'), net, {'val': m, 'epoch': ep, 'args': vars(a)})
emit(event='done', best_ce=best, seconds=round(time.time() - t0, 1))
