"""JS / PyTorch parity of the exported policy: python parity.py --ckpt bc.pt --data <dataId dir> [--n 64]"""
import argparse, glob, json, os, subprocess, tempfile
import numpy as np, torch
from data import record_dtype, unpack_mask
from model import load
torch.set_num_threads(4)  # helpers never take the whole CPU set
ap = argparse.ArgumentParser(); ap.add_argument('--ckpt', required=True); ap.add_argument('--data', required=True); ap.add_argument('--n', type=int, default=64)
ap.add_argument('--node', default='node')
a = ap.parse_args()
net, _ = load(a.ckpt); net.eval()
mp = sorted(glob.glob(a.data + '/*.meta.json'))[0]
meta = json.load(open(mp))
rec = np.memmap(mp[:-len('.meta.json')] + '.bin', dtype=record_dtype(meta), mode='r')
idx = np.linspace(0, len(rec) - 1, a.n).astype(int)
obs = np.asarray(rec['obs'][idx]).astype(np.float32); mask = unpack_mask(np.asarray(rec['mask'][idx]), meta['A'])
with torch.no_grad():
    lt, vt = net(torch.from_numpy(obs), torch.from_numpy(mask))
d = tempfile.mkdtemp(); base = os.path.join(d, 'policy')
here = os.path.dirname(os.path.abspath(__file__))
subprocess.run(['python', os.path.join(here, 'export.py'), '--ckpt', a.ckpt, '--out', base], check=True)
obs.astype('<f4').tofile(base + '.obs'); mask.astype(np.uint8).tofile(base + '.mask')
js = json.loads(subprocess.run([a.node, os.path.join(here, '..', 'infer.mjs'), base, base + '.obs', base + '.mask', str(a.n)], capture_output=True, check=True).stdout)
lj, vj = np.array(js['logits'], dtype=np.float32), np.array(js['values'], dtype=np.float32)
legal = mask
diff = np.abs(np.where(legal, lj - lt.numpy(), 0)).max()
same_argmax = float((lj.argmax(1) == lt.numpy().argmax(1)).mean())
print(json.dumps({'n': a.n, 'max_abs_logit_diff_legal': float(diff), 'max_abs_value_diff': float(np.abs(vj - vt.numpy()).max()),
                  'argmax_agree': same_argmax, 'js_ms_per_forward': round(js['msPerForward'], 3)}))
