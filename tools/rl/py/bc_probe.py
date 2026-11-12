"""Architecture / capacity probe on the bc1 behaviour-cloning data (ppo3): same shards, split, epochs, batch, cosine LR
and value weight as train_bc.py; the data stays in host memory and moves to the GPU per batch.
python bc_probe.py --data <dataId dir> --out <dir> --variant a|b|c|c4|d [--seed 1] [--overfit 0] [--mem-frac 0.3]
Writes <out>/<variant>-s<seed>[-overfit].json: per-epoch val (ce, acc by kind and action group, value mse), train metrics on
a fixed 200k train subset, params, FLOPs per forward, wall time, estimated plain-JS forward cost."""
import argparse, json, math, os, time
import numpy as np
import torch
import torch.nn.functional as F
torch.set_num_threads(2)
from data import load_shards, unpack_mask
from model2 import SPNet2, flops_per_forward

VARIANTS = {
    'a': dict(width=1.0, trunk='mlp'),                    # SPNet as trained (bc1)
    'b': dict(width=2.0, trunk='mlp'),                    # 2x width
    'c': dict(width=1.0, trunk='resln', depth=4),         # deeper residual + LayerNorm trunk
    'c4': dict(width=4.0, trunk='mlp'),                   # 4x width
    'd': dict(width=1.0, trunk='mlp', attn=2, attn_dim=128, heads=4),  # entity self-attention before pooling
    'dc': dict(width=1.0, trunk='resln', depth=4, attn=2, attn_dim=128, heads=4),
}
GROUPS = {'scalar': (0, 4), 'buy': (4, 14), 'sell': (14, 41), 'reward': (41, 47), 'personal': (47, 52), 'card': (52, 60)}
SPNET_JS_MS, SPNET_FLOPS = 7.761, None  # measured: infer.mjs, 1.32M-param SPNet, one decision (parity.py)

ap = argparse.ArgumentParser()
ap.add_argument('--data', required=True); ap.add_argument('--out', required=True); ap.add_argument('--variant', required=True)
ap.add_argument('--seed', type=int, default=1); ap.add_argument('--epochs', type=int, default=6); ap.add_argument('--batch', type=int, default=4096)
ap.add_argument('--lr', type=float, default=1e-3); ap.add_argument('--vf', type=float, default=0.5); ap.add_argument('--gamma', type=float, default=0.997)
ap.add_argument('--overfit', type=int, default=0, help='train on this many samples only (memorisation test)')
ap.add_argument('--mem-frac', type=float, default=0.3); ap.add_argument('--val-every', type=int, default=20)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
torch.manual_seed(a.seed); np.random.seed(a.seed)
dev = torch.device('cuda')
torch.cuda.set_per_process_memory_fraction(a.mem_frac, 0)  # never crowd the ppo2 learner on the shared GPU
t0 = time.time()
shards = load_shards(a.data, a.gamma)
spec = shards[0][1]['spec']; A = spec['actions']
val_sel = [s for i, s in enumerate(shards) if i % a.val_every == a.val_every - 1] or shards[-1:]
train_sel = [s for s in shards if s not in val_sel] or shards
def stack(sel):
    return (np.concatenate([np.asarray(s[2]['obs']) for s in sel]), np.concatenate([unpack_mask(np.asarray(s[2]['mask']), A) for s in sel]),
            np.concatenate([np.asarray(s[2]['action']).astype(np.int64) for s in sel]), np.concatenate([np.asarray(s[2]['kind']).astype(np.int64) for s in sel]),
            np.concatenate([s[3] for s in sel]))
TR, VA = stack(train_sel), stack(val_sel)
if a.overfit:
    TR = tuple(x[:a.overfit] for x in TR)
N = len(TR[2]); load_s = time.time() - t0
sub = np.random.default_rng(0).choice(N, size=min(N, 200_000), replace=False)
TRS = tuple(x[sub] for x in TR)
net = SPNet2(spec, **VARIANTS[a.variant]).to(dev)
params = sum(p.numel() for p in net.parameters())
opt = torch.optim.AdamW(net.parameters(), lr=a.lr, weight_decay=1e-5)
epochs = a.epochs if not a.overfit else max(a.epochs, 30)
steps_total = epochs * math.ceil(N / a.batch)
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps_total))))
def to_dev(D, idx):
    o, m, ac, k, r = (x[idx] for x in D)
    return (torch.from_numpy(o).to(dev, non_blocking=True).float(), torch.from_numpy(m).to(dev), torch.from_numpy(ac).to(dev),
            torch.from_numpy(k).to(dev), torch.from_numpy(r).to(dev))

@torch.no_grad()
def evaluate(D):
    net.eval(); n = len(D[2]); ce = vl = 0.0; ok_all = []
    by = {g: [0, 0] for g in GROUPS}; byk = {'prep': [0, 0, 0.0], 'card': [0, 0, 0.0]}
    for i in range(0, n, 8192):
        o, m, ac, k, r = to_dev(D, np.arange(i, min(n, i + 8192)))
        lg, v = net(o, m)
        ce_i = F.cross_entropy(lg, ac, reduction='none'); ce += ce_i.sum().item(); vl += F.mse_loss(v, r, reduction='sum').item()
        ok = lg.argmax(1) == ac
        for g, (lo, hi) in GROUPS.items():
            sel = (ac >= lo) & (ac < hi); by[g][0] += ok[sel].sum().item(); by[g][1] += sel.sum().item()
        for kn, kv in (('prep', 0), ('card', 1)):
            sel = k == kv; byk[kn][0] += ok[sel].sum().item(); byk[kn][1] += sel.sum().item(); byk[kn][2] += ce_i[sel].sum().item()
        ok_all.append(ok.sum().item())
    net.train()
    return {'ce': ce / n, 'acc': sum(ok_all) / n, 'vmse': vl / n, 'acc_by': {g: (c / t if t else None) for g, (c, t) in by.items()},
            'by_kind': {kn: {'acc': c / t if t else None, 'ce': s / t if t else None, 'n': t} for kn, (c, t, s) in byk.items()}}

log = []; t1 = time.time(); step = 0
for ep in range(epochs):
    perm = np.random.permutation(N)
    for i in range(0, N, a.batch):
        o, m, ac, k, r = to_dev(TR, np.sort(perm[i:i + a.batch]))
        lg, v = net(o, m)
        loss = F.cross_entropy(lg, ac) + a.vf * F.mse_loss(v, r)
        opt.zero_grad(set_to_none=True); loss.backward(); torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0); opt.step(); sched.step(); step += 1
    if not a.overfit or ep % 5 == 4 or ep == epochs - 1:
        e = {'epoch': ep, 'train': evaluate(TRS), 'val': evaluate(VA), 'seconds': round(time.time() - t1, 1)}
        log.append(e); print(json.dumps({'variant': a.variant, 'epoch': ep, 'val_ce': round(e['val']['ce'], 4), 'val_acc': round(e['val']['acc'], 4),
                                         'train_acc': round(e['train']['acc'], 4), 'sec': e['seconds']}), flush=True)
train_s = time.time() - t1
# cost per decision: FLOPs, and a single-thread CPU torch timing (batch 1) as a proxy next to the measured JS figure
net_cpu = SPNet2(spec, **VARIANTS[a.variant]).eval(); net_cpu.load_state_dict({k_: v_.cpu() for k_, v_ in net.state_dict().items()})
ob = torch.from_numpy(VA[0][:64]).float(); mk = torch.from_numpy(VA[1][:64])
fl = flops_per_forward(net_cpu, ob, mk)
torch.set_num_threads(1)
with torch.no_grad():
    for j in range(8): net_cpu(ob[j:j + 1], mk[j:j + 1])
    tt = time.time()
    for j in range(64): net_cpu(ob[j:j + 1], mk[j:j + 1])
    cpu_ms = (time.time() - tt) / 64 * 1000
ref = SPNet2(spec, **VARIANTS['a']).eval(); ref_fl = flops_per_forward(ref, ob, mk)
res = {'variant': a.variant, 'cfg': VARIANTS[a.variant], 'seed': a.seed, 'overfit': a.overfit, 'params': params, 'train_samples': N,
       'val_samples': len(VA[2]), 'load_s': round(load_s, 1), 'train_s': round(train_s, 1), 'flops': fl, 'flops_vs_a': fl / ref_fl,
       'torch_cpu_1thread_ms': round(cpu_ms, 3), 'js_ms_est': round(SPNET_JS_MS * fl / ref_fl, 2), 'log': log,
       'gpu_mem_peak_gb': round(torch.cuda.max_memory_allocated() / 2**30, 2)}
name = f"{a.variant}-s{a.seed}{'-overfit' + str(a.overfit) if a.overfit else ''}.json"
if not a.overfit:
    from model import save
    save(os.path.join(a.out, name[:-5] + '.pt'), net_cpu, {'probe': res['log'][-1]['val']})
json.dump(res, open(os.path.join(a.out, name), 'w'), indent=1)
print('done', name, 'params', params, 'flops', fl, 'train_s', round(train_s), 'js_ms_est', res['js_ms_est'], flush=True)
