"""Per-round decision replays for the viewer (www/replay): the greedy policy and the rules-on legacy on the same seeds.
python replay.py --ckpt ck.pt --label ppo1-final --pick eval.json --out www/replay [--rehearsal 0]
       [--boss-rehearsal 3] [--per-config 2] [--seed-base 7000000]
--pick: an eval.py output of this checkpoint with the same rehearsal settings; its per-match records choose the seeds
(ABYSS: the longest-surviving losses; HARD: wins, preferring seeds legacy lost; NORMAL: a win and a loss) and the replay
must reproduce them (checked). CPU only; torch threads capped."""
import argparse, json, os, time
import numpy as np
import torch
torch.set_num_threads(2)
from spenv import NodeEnv
from model import load

ap = argparse.ArgumentParser()
ap.add_argument('--ckpt', required=True); ap.add_argument('--label', required=True); ap.add_argument('--pick', required=True)
ap.add_argument('--ref', help='eval.py output of the rules-on legacy on the same seeds (to prefer seeds where it lost)')
ap.add_argument('--out', required=True); ap.add_argument('--rehearsal', type=int, default=0)
ap.add_argument('--boss-rehearsal', type=int, default=None); ap.add_argument('--per-config', type=int, default=2)
ap.add_argument('--seed-base', type=int, default=7_000_000); ap.add_argument('--node', default='node')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
net, _ = load(a.ckpt, 'cpu'); net.eval()
pick = json.load(open(a.pick))['configs']
ref = json.load(open(a.ref))['configs'] if a.ref else {}


def choose(cfg, c):
    ms = c.get('perMatch') or []
    lost_ref = {m['seed'] for m in (ref.get(cfg, {}).get('perMatch') or []) if not m['win']}
    wins = [m for m in ms if m['win']]; losses = [m for m in ms if not m['win']]
    key = lambda m: (-(m.get('faShare') or 0), -m['rlSurvival'])
    if cfg.endswith(':ABYSS'):
        out = sorted(losses, key=key)[:a.per_config]
    elif cfg.endswith(':HARD'):
        out = sorted(wins, key=lambda m: (m['seed'] not in lost_ref, -m['rlSurvival']))[:a.per_config]
    else:
        out = (wins[:1] + sorted(losses, key=key)[:1]) or wins[:a.per_config]
    return out[:a.per_config] or ms[:a.per_config]


def opts(cfg, seed, mode):
    o = {'envs': 1, 'configs': [cfg], 'seed': seed, 'envSeed': a.seed_base, 'maxMatches': 1, 'humans': 'random', 'legacyMates': 0,
         'rehearsal': a.rehearsal, 'metrics': True, 'check': True, 'describeSeats': ['ai_0'], 'mode': mode,
         'obsVersion': 3 if 'bands' in net.spec['blocks'] else 2}
    if mode == 'teacher':
        o['enforce'] = True
    if a.boss_rehearsal is not None:
        o['bossRehearsal'] = a.boss_rehearsal
    return o


def seat_result(res):
    s = next(x for x in res['seats'] if x['playerId'] == 'ai_0')
    return {'survival': s['survivalRound'], 'lp': s['lp'], 'win': s['win'], 'fa': res.get('faShare', 0),
            'team': [{'id': x['playerId'], 'role': x['role'], 'survival': x['survivalRound'], 'lp': x['lp'], 'win': x['win']} for x in res['seats']]}


def run_policy(cfg, seed):
    e = NodeEnv(opts(cfg, seed, 'policy'), node=a.node)
    e.reset_async(); b = e.wait(); decisions = []
    while b.n:
        desc = e.describe()
        with torch.no_grad():
            logits, v = net(torch.from_numpy(np.array(b.obs)), torch.from_numpy(np.array(b.mask)))
            probs = torch.softmax(logits, 1).numpy()
        acts = probs.argmax(1).astype(np.int32)
        for k, d in enumerate(desc):
            if d is None:
                continue
            top = np.argsort(-probs[k])[:5]
            decisions.append({'s': d['s'], 'labels': d['labels'], 'a': int(acts[k]), 'v': round(float(v[k]), 4),
                              'top': [[int(t), round(float(probs[k, t]), 4)] for t in top if b.mask[k, t]]})
        e.step_async(acts); b = e.wait()
    st = e.stats(); e.close()
    res = st['results'][0]
    return {'names': res['names'], 'decisions': decisions, 'result': seat_result(res), 'errors': st['stats']['errors'] + st['stats']['failed']}


def run_legacy(cfg, seed):
    e = NodeEnv(opts(cfg, seed, 'teacher'), node=a.node)
    e.reset_async(); b = e.wait()
    assert b.n == 0, 'teacher mode returns no decisions'
    st = e.stats(); e.close()
    res = st['results'][0]
    return {'names': res['names'], 'preps': res['replay'], 'result': seat_result(res), 'errors': st['stats']['errors'] + st['stats']['failed']}


index_path = os.path.join(a.out, 'index.json')
index = json.load(open(index_path)) if os.path.exists(index_path) else []
for cfg, c in pick.items():
    for m in choose(cfg, c):
        t0 = time.time()
        pol, leg = run_policy(cfg, m['seed']), run_legacy(cfg, m['seed'])
        same = (pol['result']['win'] == m['win']) and abs(np.mean([x['survival'] for x in pol['result']['team'] if x['role'] == 'rl'] or [0]) - m['rlSurvival']) < 1e-6
        name = f"{a.label}-{cfg.replace(':', '-')}-{m['seed']}.json"
        doc = {'label': a.label, 'config': cfg, 'seed': m['seed'], 'rehearsal': a.rehearsal, 'bossRehearsal': a.boss_rehearsal,
               'reproduced': bool(same), 'policy': pol, 'legacy': leg, 'time': time.time()}
        with open(os.path.join(a.out, name), 'w') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        index = [x for x in index if x['file'] != name] + [{'file': name, 'label': a.label, 'config': cfg, 'seed': m['seed'],
                 'policy': pol['result'], 'legacy': leg['result'], 'reproduced': bool(same), 'time': time.time()}]
        print(f"{name}: policy win {pol['result']['win']} surv {pol['result']['survival']} fa {pol['result']['fa']:.3f} | legacy win "
              f"{leg['result']['win']} surv {leg['result']['survival']} | decisions {len(pol['decisions'])} preps {len(leg['preps'])}"
              f" | reproduced {same} | errors {pol['errors']}/{leg['errors']} | {os.path.getsize(os.path.join(a.out, name)) / 1024:.0f} KB {time.time() - t0:.0f}s", flush=True)
json.dump(sorted(index, key=lambda x: (x['label'], x['config'], x['seed'])), open(index_path, 'w'), ensure_ascii=False, indent=0)
