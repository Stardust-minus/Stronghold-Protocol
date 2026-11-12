"""Export a checkpoint for the plain-JS forward pass (tools/rl/infer.mjs): <out>.json (manifest) + <out>.bin (f32 LE).
python export.py --ckpt runs/x/model.pt --out runs/x/policy"""
import argparse, json
import numpy as np
from model import load, EMB, ENTITY_OUT, POINTER, SCALARS
import torch
torch.set_num_threads(4)  # helpers never take the whole CPU set

ap = argparse.ArgumentParser(); ap.add_argument('--ckpt', required=True); ap.add_argument('--out', required=True)
a = ap.parse_args()
net, ck = load(a.ckpt)
tensors, chunks, off = {}, [], 0
for name, t in net.state_dict().items():
    arr = t.detach().cpu().numpy().astype('<f4')
    tensors[name] = {'offset': off, 'shape': list(arr.shape)}
    chunks.append(arr.tobytes()); off += arr.size
layout = {n: {'offset': o, 'count': c, 'width': w, 'ids': [[f, v] for f, v in ids],
              'numeric': getattr(net, f'num_{n}').tolist()} for n, (o, c, w, ids) in net.layout.items()}
manifest = {'format': 'sp-policy/1', 'dataId': net.spec['dataId'], 'D': net.D, 'A': net.A, 'emb': EMB, 'entityOut': ENTITY_OUT,
            'pointer': getattr(net, 'pointer', POINTER), 'scalars': SCALARS, 'layout': layout, 'bondsAt': list(net.bonds_at), 'tensors': tensors,
            'steps': ck.get('steps'), 'stage': ck.get('stage')}
open(a.out + '.bin', 'wb').write(b''.join(chunks))
json.dump(manifest, open(a.out + '.json', 'w'))
print('exported', len(tensors), 'tensors', off, 'floats', round(off * 4 / 1e6, 2), 'MB')
