"""Same-seed paired comparison of eval.py outputs (review B4):
python compare.py <dir> REF:RUN [REF:RUN ...]   RUN may be ck1+ck2+ck3 (several checkpoints, averaged per seed).
Primary for ABYSS: fa (Final Assault pool share), per-seed paired difference, mean / IQM / 95 % paired bootstrap CI.
Secondary: win rate with Wilson CI and exact McNemar (per checkpoint), survival, LP, rule counts, round trips."""
import json, sys
import numpy as np
from stats import wilson, mcnemar_p, iqm, paired_bootstrap


def load(d, stem):
    return json.load(open(f'{d}/{stem}.json'))


def compare(d, ref, runs):
    A = load(d, ref); Bs = [load(d, r) for r in runs]
    out = {}
    for cfg, ca in A['configs'].items():
        cbs = [B['configs'].get(cfg) for B in Bs]
        if any(c is None for c in cbs):
            continue
        ma = {m['seed']: m for m in ca['perMatch']}
        mbs = [{m['seed']: m for m in c['perMatch']} for c in cbs]
        seeds = sorted(set(ma).intersection(*[set(mb) for mb in mbs]))
        n = len(seeds)
        if not n:
            continue
        def per_seed(key):
            a = np.array([ma[s].get(key, 0) for s in seeds], dtype=np.float64)
            b = np.array([[mb[s].get(key, 0) for s in seeds] for mb in mbs], dtype=np.float64)
            return a, b
        fa_a, fa_b = per_seed('faShare'); df = fa_b.mean(0) - fa_a
        sv_a, sv_b = per_seed('rlSurvival'); dsv = sv_b.mean(0) - sv_a
        w_a, w_b = per_seed('win'); lp_a, lp_b = per_seed('rlLp')
        ka = int(w_a.sum())
        cks = []
        for j in range(len(mbs)):
            only_a = int(((w_a == 1) & (w_b[j] == 0)).sum()); only_b = int(((w_b[j] == 1) & (w_a == 0)).sum())
            cks.append({'win': float(w_b[j].mean()), 'wilson': wilson(int(w_b[j].sum()), n), 'onlyRef': only_a, 'onlyRun': only_b,
                        'mcnemarP': mcnemar_p(only_a, only_b)})
        kb = int(w_b.sum())
        out[cfg] = {'n': n, 'checkpoints': len(mbs),
                    'fa': {'ref': float(fa_a.mean()), 'run': float(fa_b.mean()), 'dMean': float(df.mean()), 'dIQM': iqm(df),
                           'dCI': paired_bootstrap(df)},
                    'win': {'ref': ka / n, 'refWilson': wilson(ka, n), 'run': kb / (n * len(mbs)), 'runWilson': wilson(kb, n * len(mbs)),
                            'perCheckpoint': cks},
                    'survival': {'ref': float(sv_a.mean()), 'run': float(sv_b.mean()), 'dMean': float(dsv.mean()), 'dCI': paired_bootstrap(dsv)},
                    'lp': {'ref': float(lp_a.mean()), 'run': float(lp_b.mean())},
                    'rules': {'ref': ca['ai'].get('rl', {}), 'run': [c['ai'].get('rl', {}) for c in cbs]},
                    'human': {'ref': ca['roles'].get('human-legacy', {}), 'run': [c['roles'].get('human-legacy', {}) for c in cbs]},
                    'errors': [ca['errors']] + [c['errors'] for c in cbs]}
    return out


def show(d, ref, runs):
    res = compare(d, ref, runs)
    print(f"== {'+'.join(runs)} vs {ref}")
    for cfg, r in res.items():
        fa, w, sv = r['fa'], r['win'], r['survival']
        viol = sum(int(x.get('violations', 0)) for x in r['rules']['run'])
        rt = np.mean([x.get('roundTripsPerPrep', 0) for x in r['rules']['run']])
        mc = ' '.join(f"p={c['mcnemarP']:.2g}({c['onlyRef']}/{c['onlyRun']})" for c in w['perCheckpoint'])
        print(f"  {cfg:13s} n={r['n']} x{r['checkpoints']} | fa {fa['ref']:.3f}→{fa['run']:.3f} d={fa['dMean']:+.3f} IQM {fa['dIQM']:+.3f}"
              f" CI[{fa['dCI'][0]:+.3f},{fa['dCI'][1]:+.3f}] | win {w['ref']:.3f}[{w['refWilson'][0]:.3f},{w['refWilson'][1]:.3f}]→{w['run']:.3f}"
              f"[{w['runWilson'][0]:.3f},{w['runWilson'][1]:.3f}] {mc} | surv {sv['dMean']:+.2f} CI[{sv['dCI'][0]:+.2f},{sv['dCI'][1]:+.2f}]"
              f" | lp {r['lp']['ref']:.1f}→{r['lp']['run']:.1f} | violations {viol} rt/prep {r['rules']['ref'].get('roundTripsPerPrep', 0):.3f}→{rt:.3f} | err {r['errors']}")
    return res


if __name__ == '__main__':
    d = sys.argv[1]
    allres = {}
    for pair in sys.argv[2:]:
        ref, run = pair.split(':')
        allres[pair] = show(d, ref, run.split('+'))
    json.dump(allres, open(f'{d}/compare.json', 'w'), indent=1)
