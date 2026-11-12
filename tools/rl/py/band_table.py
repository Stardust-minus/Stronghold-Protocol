"""Step 0 — band strength table (ppo3 band choice): python band_table.py --ckpt ck.pt --out dir [--configs solo:ABYSS,coop4:ABYSS,solo:HARD,coop4:HARD]
  [--matches 48] [--rehearsal 0 --boss-rehearsal 3]
For each config: the checkpoint (greedy) with seat ai_0 forced to every allowed band, and with legacy's own random pick,
all on one seed set (paired). Per band: fa (paired difference vs the random pick, bootstrap 95 %), win, survival, LP, how
often the forced band was really obtained. Headline: best band per config vs the random pick (the value of band choice)."""
import argparse, json, os, subprocess, sys
import numpy as np
from stats import paired_bootstrap, wilson

ap = argparse.ArgumentParser(); ap.add_argument('--ckpt', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--configs', default='solo:ABYSS,coop4:ABYSS,solo:HARD,coop4:HARD'); ap.add_argument('--matches', type=int, default=48)
ap.add_argument('--rehearsal', type=int, default=0); ap.add_argument('--boss-rehearsal', type=int, default=3); ap.add_argument('--device', default='cuda')
ap.add_argument('--bands', default='', help='comma list (default: all 40 of data/bands.json)')
a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
here = os.path.dirname(os.path.abspath(__file__))
bands = a.bands.split(',') if a.bands else sorted(json.load(open(os.path.join(here, '../../../data/bands.json'))).keys())
def ev(name, extra):
    out = os.path.join(a.out, f'{name}.json')
    if not os.path.exists(out):
        cmd = [sys.executable, os.path.join(here, 'eval.py'), '--ckpt', a.ckpt, '--greedy', '--device', a.device, '--configs', a.configs,
               '--matches', str(a.matches), '--chunks', '4', '--envs', '6', '--rehearsal', str(a.rehearsal), '--boss-rehearsal', str(a.boss_rehearsal),
               '--out', out] + extra
        subprocess.run(cmd, stdout=open(out + '.log', 'w'), stderr=subprocess.STDOUT, check=False)
    return json.load(open(out))['configs'] if os.path.exists(out) else {}
base = ev('random-pick', [])
table = {}
for b in bands:
    r = ev(f'band-{b}', ['--force-band', b])
    for cfg, c in r.items():
        B = {m['seed']: m for m in base.get(cfg, {}).get('perMatch', [])}
        ms = [m for m in c['perMatch'] if m['seed'] in B]
        got = [m for m in ms if m.get('band0') == b]
        if len(got) < max(8, len(ms) // 3):
            continue  # band not allowed in this mode, or rarely obtained
        d = np.array([m['faShare'] - B[m['seed']]['faShare'] for m in got]); w = sum(m['win'] for m in got)
        table.setdefault(cfg, []).append({'band': b, 'n': len(got), 'fa': float(np.mean([m['faShare'] for m in got])), 'dfa': float(d.mean()),
            'dfaCI': paired_bootstrap(d), 'win': w / len(got), 'winCI': wilson(w, len(got)),
            'survival': float(np.mean([m['rlSurvival'] for m in got])), 'lp': float(np.mean([m['rlLp'] for m in got]))})
summary = {}
for cfg, rows in table.items():
    rows.sort(key=lambda x: -x['fa'])
    bc = base[cfg]
    summary[cfg] = {'randomPick': {'fa': bc['faShare'], 'win': bc['teamWin']}, 'best': rows[0], 'worst': rows[-1], 'bands': rows}
    print(f"{cfg}: random pick fa {bc['faShare']:.3f} win {bc['teamWin']:.3f} | best {rows[0]['band']} fa {rows[0]['fa']:.3f} (d {rows[0]['dfa']:+.3f} "
          f"CI [{rows[0]['dfaCI'][0]:+.3f}, {rows[0]['dfaCI'][1]:+.3f}]) win {rows[0]['win']:.3f} | worst {rows[-1]['band']} fa {rows[-1]['fa']:.3f}")
json.dump(summary, open(os.path.join(a.out, 'band_table.json'), 'w'), indent=1, ensure_ascii=False)
