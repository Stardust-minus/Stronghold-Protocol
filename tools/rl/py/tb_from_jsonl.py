"""TensorBoard events from an existing run log (CPU only): python tb_from_jsonl.py --run runs/ppo1 [--baseline teacher=path]
  PPO: train.jsonl updates → the same scalar tags as train_ppo.py (reward components and histograms only exist in runs
  logged live), eval-*.json (and eval events) → per-config scalars and differences vs the baselines.
  BC: bc-log.jsonl → bc/train_* and bc/val_* scalars. Output: <run>/tb (replaced)."""
import argparse, glob, json, os, shutil
import torch
torch.set_num_threads(4)
from tb import Board, eval_steps

ap = argparse.ArgumentParser()
ap.add_argument('--run', required=True); ap.add_argument('--out')
ap.add_argument('--baseline', action='append', default=[], help='name=path of an eval.py output on the in-run eval seeds')
a = ap.parse_args()
out = a.out or os.path.join(a.run, 'tb')
shutil.rmtree(out, ignore_errors=True)
board = Board(out, None, dict(x.split('=', 1) for x in a.baseline))
n = 0
ppo = os.path.join(a.run, 'train.jsonl')
if os.path.exists(ppo):
    seen = set()
    for line in open(ppo):
        e = json.loads(line)
        if e['event'] == 'update':
            st = {'normal': 0, 'hard': 1, 'abyss': 2, 'mix': 0}.get(e.get('stage'), 0)
            board.update(e['steps'], {**e, 'stage': st}, e.get('rolling'), None, {}, None, walltime=e.get('t')); n += 1
        elif e['event'] == 'eval' and os.path.exists(e['path']):
            board.eval(e['path'], walltime=e.get('t')); seen.add(os.path.basename(e['path']))
    for p in sorted(glob.glob(os.path.join(a.run, 'eval-*.json')), key=eval_steps):
        if os.path.basename(p) not in seen:
            board.eval(p, walltime=os.path.getmtime(p))
bc = os.path.join(a.run, 'bc-log.jsonl')
if os.path.exists(bc):
    for line in open(bc):
        e = json.loads(line)
        if e['event'] == 'train':
            for k in ('ce', 'vmse', 'lr'):
                board.w.add_scalar(f'bc/train_{k}', e[k], e['step'], walltime=e.get('t'))
        elif e['event'] == 'val':
            for k in ('ce', 'acc', 'vmse'):
                board.w.add_scalar(f'bc/val_{k}', e[k], e['step'], walltime=e.get('t'))
            for g, v in (e.get('acc_by') or {}).items():
                if v is not None:
                    board.w.add_scalar(f'bc/val_acc_{g}', v, e['step'], walltime=e.get('t'))
        n += 1
board.close()
print('events from', n, 'log lines into', out)
