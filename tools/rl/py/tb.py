"""TensorBoard logging of the RL runs (train_ppo.py live, tb_from_jsonl.py after the fact): one place for the tag names.
Scalars per update, histograms every few updates, per-config scalars and paired differences per evaluation."""
import json, os, re
import numpy as np
import torch
from torch.utils.tensorboard import SummaryWriter

TYPES = ['end', 'refresh', 'level', 'freeze', 'buy', 'sell', 'reward', 'personal', 'card']
SCALAR_KEYS = ['sps', 'pg', 'vloss', 'ent', 'kl', 'kl3', 'clipfrac', 'update_s', 'bc_coef', 'kl_bc', 'stage', 'samples', 'epochs', 'warmup',
               'env_errors', 'env_rejected', 'env_violations']


def eval_steps(path):
    m = re.search(r'eval-(\d+)\.json$', path)
    return int(m.group(1)) if m else 0


def paired(cur, base):
    """Mean paired differences (win, survival, fa) over the seeds both ran; difference of means when perMatch is missing."""
    if cur.get('perMatch') and base.get('perMatch'):
        b = {m['seed']: m for m in base['perMatch']}
        ms = [m for m in cur['perMatch'] if m['seed'] in b]
        if not ms:
            return None
        n = len(ms)
        return {'n': n, 'win': sum(m['win'] - b[m['seed']]['win'] for m in ms) / n,
                'survival': sum(m['rlSurvival'] - b[m['seed']]['rlSurvival'] for m in ms) / n,
                'fa': sum(m.get('faShare', 0) - b[m['seed']].get('faShare', 0) for m in ms) / n}
    return {'n': cur['matches'], 'win': cur['teamWin'] - base['teamWin'],
            'survival': cur['roles'].get('rl', {}).get('survival', 0) - base['roles'].get('rl', {}).get('survival', 0), 'fa': None}


class Board:
    def __init__(self, logdir, act=None, baselines=None, purge_step=None):
        torch.set_num_threads(4)
        os.makedirs(logdir, exist_ok=True)
        self.w = SummaryWriter(logdir, flush_secs=60, purge_step=purge_step)
        self.act = act or {}
        self.bounds = [act[k] for k in ('REFRESH', 'LEVEL', 'FREEZE', 'BUY', 'SELL', 'REWARD', 'PERSONAL', 'CARD')] if act else None
        self.baselines = {}
        for name, path in (baselines or {}).items():
            try:
                self.baselines[name] = json.load(open(path))['configs']
            except Exception as e:  # a missing baseline only drops its differences
                print(f'baseline {name}: {e}', flush=True)

    def update(self, step, scalars, rolling, terms, R, extra=None, walltime=None, bonds=None):
        w = self.w
        for k in SCALAR_KEYS:
            v = scalars.get(k)
            if isinstance(v, (int, float)) and v is not None:
                w.add_scalar(f'train/{k}', v, step, walltime=walltime)
        for k, v in scalars.items():  # B1 diagnostics (explained variance, advantage std, entropies, loop time shares)
            if k.startswith('diag/') and isinstance(v, (int, float)) and np.isfinite(v):
                w.add_scalar(k, v, step, walltime=walltime)
        for diff, r in (rolling or {}).items():
            if not r:
                continue
            for k in ('win', 'survival', 'lp', 'fa'):
                if r.get(k) is not None:
                    w.add_scalar(f'rolling/{diff}/{k}', r[k], step, walltime=walltime)
        if terms:
            # per-episode reward components of the episodes that ended in this rollout (team-weighted terms as paid)
            t = np.array([x[1:] for x in terms], dtype=np.float64)  # win, fa share, round term, lp term
            w.add_scalar('reward/round', t[:, 2].mean(), step, walltime=walltime)
            w.add_scalar('reward/lp', t[:, 3].mean(), step, walltime=walltime)
            w.add_scalar('reward/win', R.get('win', 0) * t[:, 0].mean(), step, walltime=walltime)
            w.add_scalar('reward/boss_share', R.get('fa', 0) * t[:, 1].mean(), step, walltime=walltime)
            w.add_scalar('reward/boss_share_raw', t[:, 1].mean(), step, walltime=walltime)
            w.add_scalar('reward/episodes', len(terms), step, walltime=walltime)
            if t.shape[1] > 4:  # potential-based bond shaping, undiscounted per-episode total (≈ −Φ(start) when γ ≈ 1)
                w.add_scalar('reward/bond_shaping', t[:, 4].mean(), step, walltime=walltime)
        if bonds is not None and len(bonds[0]):
            tiers, rounds = bonds
            w.add_scalar('bonds/tier_sum', float(tiers.mean()), step, walltime=walltime)
            if extra is not None:  # by round, with the histograms
                for r in range(1, 16):
                    sel = rounds == r
                    if sel.any():
                        w.add_scalar(f'bonds/tier_sum_r{r:02d}', float(tiers[sel].mean()), step, walltime=walltime)
        if extra is not None and self.bounds:
            types = np.searchsorted(np.array(self.bounds), extra['act'], side='right')
            w.add_histogram('actions/type', types, step, bins=np.arange(len(TYPES) + 1) - 0.5)
            counts = np.bincount(types, minlength=len(TYPES)) / max(1, len(types))
            for i, name in enumerate(TYPES):
                w.add_scalar(f'actions/share_{name}', counts[i], step, walltime=walltime)
            p = extra['preps']
            if len(p):
                for j, name in enumerate(('buys', 'sells', 'refreshes')):
                    w.add_histogram(f'prep/{name}', p[:, j], step, bins=np.arange(42) - 0.5)
                    w.add_scalar(f'prep/{name}_mean', p[:, j].mean(), step, walltime=walltime)
            w.add_histogram('value/pred', extra['v'], step)
            w.add_histogram('adv/raw', extra['adv'], step)

    def eval(self, path, walltime=None):
        try:
            r = json.load(open(path))['configs']
        except Exception as e:
            print(f'eval {path}: {e}', flush=True); return
        step = eval_steps(path)
        for cfg, c in r.items():
            rl, ai = c['roles'].get('rl', {}), c['ai'].get('rl', {})
            for k, v in (('win', c['teamWin']), ('survival', rl.get('survival')), ('lp', rl.get('lp')), ('fa', c.get('faShare')),
                         ('round_trips_per_prep', ai.get('roundTripsPerPrep')), ('violations', ai.get('violations')),
                         ('human_survival', c['roles'].get('human-legacy', {}).get('survival'))):
                if v is not None:
                    self.w.add_scalar(f'eval/{cfg}/{k}', v, step, walltime=walltime)
            for name, base in self.baselines.items():
                if cfg in base:
                    d = paired(c, base[cfg])
                    if d:
                        for k in ('win', 'survival', 'fa'):
                            if d[k] is not None:
                                self.w.add_scalar(f'eval_vs_{name}/{cfg}/d{k}', d[k], step, walltime=walltime)
        self.w.flush()

    def close(self):
        self.w.flush(); self.w.close()
