"""PPO from the behaviour-cloned policy (plan §8.9, B2).
python train_ppo.py --init runs/bc/bc.pt --out runs/ppo-1 [--procs 24 --envs 16 --max-steps 3e7 --hours 24]
Asynchronous collection (AsyncPool: each environment process is stepped as soon as its batch is in), one trajectory per
policy seat, GAE per trajectory (a segment that is still running bootstraps from the value of its next decision),
clipped PPO with masked logits, an optional KL pull towards the BC policy that decays, a curriculum NORMAL → HARD →
ABYSS with legacy teammates mixed in and humans marked at random, checkpoints and same-seed evaluations (eval.py) on
the way. Logs: <out>/train.jsonl (one line per update), <out>/eval-<steps>.json."""
import argparse, json, math, os, subprocess, sys, time
os.environ.setdefault('OMP_NUM_THREADS', '4')
from collections import defaultdict, deque
import numpy as np
import torch
import torch.nn.functional as F
from spenv import NodeEnv, AsyncPool
from model import load, save
from tb import Board, TYPES
GROUPS = [f'{d}_{m}' for d in ('FUNNY', 'NORMAL', 'HARD', 'ABYSS') for m in ('solo', 'coop')]  # index = difficulty * 2 + co-op
torch.set_num_threads(4)  # the learner runs on the GPU; a wide CPU pool would only compete with the environments

def W(**kw):
    return [{'name': k.replace('_', ':'), 'w': v} for k, v in kw.items()]

STAGES = [
    {'name': 'normal', 'key': 'NORMAL', 'configs': W(solo_NORMAL=1, coop2_NORMAL=1, coop4_NORMAL=2, solo_HARD=0.25, coop4_HARD=0.5)},
    {'name': 'hard', 'key': 'HARD', 'configs': W(solo_NORMAL=0.2, coop4_NORMAL=0.3, solo_HARD=1, coop2_HARD=1, coop3_HARD=1, coop4_HARD=2, coop4_ABYSS=0.3)},
    {'name': 'abyss', 'key': 'ABYSS', 'configs': W(solo_NORMAL=0.1, coop4_NORMAL=0.1, solo_HARD=0.3, coop4_HARD=0.5, solo_ABYSS=1, coop2_ABYSS=1, coop4_ABYSS=2)},
]

# ppo2 (approved 11-12): one fixed mix by match, ABYSS 60 % / HARD 30 % / NORMAL 10 %
FIXED = [{'name': 'mix', 'key': 'ABYSS', 'configs': W(solo_ABYSS=0.15, coop2_ABYSS=0.15, coop4_ABYSS=0.30,
                                                      solo_HARD=0.075, coop2_HARD=0.075, coop3_HARD=0.05, coop4_HARD=0.10,
                                                      solo_NORMAL=0.03, coop2_NORMAL=0.03, coop4_NORMAL=0.04)}]

def cpu_list(s):
    out = set()
    for part in s.split(','):
        lo, _, hi = part.partition('-'); out.update(range(int(lo), int(hi or lo) + 1))
    return out

ap = argparse.ArgumentParser()
ap.add_argument('--init', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--procs', type=int, default=24); ap.add_argument('--envs', type=int, default=16)
ap.add_argument('--rollout', type=int, default=32768); ap.add_argument('--epochs', type=int, default=3)
ap.add_argument('--minibatch', type=int, default=4096); ap.add_argument('--lr', type=float, default=1e-4)
ap.add_argument('--clip', type=float, default=0.2); ap.add_argument('--vf', type=float, default=0.5)
ap.add_argument('--ent', type=float, default=0.003); ap.add_argument('--gamma', type=float, default=0.997)
ap.add_argument('--lam', type=float, default=0.95); ap.add_argument('--target-kl', type=float, default=0.02)
ap.add_argument('--bc-kl', type=float, default=0.1); ap.add_argument('--bc-kl-steps', type=float, default=5e6)
ap.add_argument('--max-steps', type=float, default=3e7); ap.add_argument('--hours', type=float, default=24)
ap.add_argument('--ckpt-every', type=float, default=1e6); ap.add_argument('--eval-every', type=float, default=3e6)
ap.add_argument('--baseline', help='eval.py --teacher JSON: promotion = 95%% of its team win at the stage difficulty')
ap.add_argument('--stage-min', type=float, default=2e6); ap.add_argument('--stage-max', type=float, default=1e7)
ap.add_argument('--legacy-mates', type=float, default=0.3); ap.add_argument('--node', default='node')
ap.add_argument('--eval-matches', type=int, default=24); ap.add_argument('--eval-chunks', type=int, default=2)
ap.add_argument('--eval-configs', default='solo:NORMAL,solo:HARD,solo:ABYSS,coop4:NORMAL,coop4:HARD,coop4:ABYSS')
ap.add_argument('--curriculum', choices=['staged', 'fixed'], default='staged')
ap.add_argument('--rehearsal', type=int, default=0, help='legacy layout rehearsal candidates in the training matches')
ap.add_argument('--reward', default='{}', help='JSON overrides of env.mjs REWARD, e.g. {"round":0.05,"fa":1.5}')
ap.add_argument('--vf-warmup', type=int, default=0, help='first updates train the value head only (a new reward)')
ap.add_argument('--learner-cpus', default='', help='CPU list for the learner after the environments are spawned')
ap.add_argument('--env-cpus', default='', help='CPU list the environment processes are spawned with (default: the whole unit)')
ap.add_argument('--check', action='store_true', help='collectViolations at every match end in the environments')
ap.add_argument('--eval-baselines', default='', help='name=path,... eval.py outputs on the in-run eval seeds (paired differences in TensorBoard)')
ap.add_argument('--hist-every', type=int, default=10, help='TensorBoard histograms every n updates')
ap.add_argument('--overlap', action='store_true', help='T1: update on a learner copy in a thread while the actor keeps collecting')
ap.add_argument('--device', default='cuda', help='cuda, or cpu for smoke tests while the GPU is taken')
# ppo3 candidates (off by default)
ap.add_argument('--plr', type=float, default=0.0, help='S3: share of new matches that replay a buffered level (seed)')
ap.add_argument('--plr-buffer', type=int, default=256); ap.add_argument('--plr-beta', type=float, default=0.1)
ap.add_argument('--plr-staleness', type=float, default=0.3)
ap.add_argument('--sil', type=float, default=0.0, help='S2: self-imitation loss weight (0 = off)')
ap.add_argument('--sil-buffer', type=int, default=100000); ap.add_argument('--sil-batches', type=int, default=4)
ap.add_argument('--sil-vf', type=float, default=0.01)
ap.add_argument('--snap-start', type=float, default=0.0, help='S1: share of ABYSS matches started from late-game checkpoints')
ap.add_argument('--snap-collect', type=float, default=0.25, help='S1: chance an eligible ABYSS prep-end (R9-13) is pooled')
ap.add_argument('--band-policy', type=float, default=0.0, help='share of RL seats whose opening band the policy picks (0 = legacy)')
ap.add_argument('--band-warmstart', default='', help='Step 2: band_table.json; the band head first fits softmax(fa / tau) per config')
ap.add_argument('--band-tau', type=float, default=0.05); ap.add_argument('--band-warm-steps', type=int, default=300)
ap.add_argument('--www', default='', help='eval report pages: a directory (eval_report.py), one page per in-run evaluation')
ap.add_argument('--vclip', type=float, default=0.2, help='PPO value clipping (0 = plain MSE)')
ap.add_argument('--adv-norm', choices=['global', 'group'], default='global', help='advantage normalisation (group = difficulty x solo/co-op)')
ap.add_argument('--boss-rehearsal', type=int, default=None, help='legacy rehearsal on the Final Assault / Hidden Core rounds only')
ap.add_argument('--shape-tier', type=float, default=0.0, help='bond shaping: weight of Σ active tier / max tier (potential-based)')
ap.add_argument('--shape-stack', type=float, default=0.0, help='bond shaping: weight of Σ min(layers / next milestone, 1), active bonds')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
if a.curriculum == 'fixed':
    STAGES = FIXED
reward_over = json.loads(a.reward)
dev = torch.device(a.device)
logf = open(os.path.join(a.out, 'train.jsonl'), 'a')
def emit(**kw):
    kw['t'] = round(time.time(), 1); line = json.dumps(kw); print(line, flush=True); logf.write(line + '\n'); logf.flush()

net, ck = load(a.init, dev)
bc_net = None
if a.bc_kl > 0:
    bc_net, _ = load(a.init, dev); bc_net.eval()
    for p in bc_net.parameters():
        p.requires_grad_(False)
opt = torch.optim.Adam(net.parameters(), lr=a.lr, eps=1e-5)
import copy, threading
actor = copy.deepcopy(net) if a.overlap else net  # T1: the network that acts; net is the learner
actor.eval()
value_params = list(net.value.parameters())
opt_v = torch.optim.Adam(value_params, lr=a.lr, eps=1e-5)  # A1: the value-only warm-up
spec = net.spec
threshold = {}
if a.baseline:
    base = json.load(open(a.baseline))['configs']
    for key in ('NORMAL', 'HARD', 'ABYSS'):
        ws = [c['teamWin'] for name, c in base.items() if name.endswith(':' + key)]
        if ws:
            threshold[key] = 0.95 * sum(ws) / len(ws)
stage, stage_since = 0, 0
cfg_names = [c['name'] for c in STAGES[0]['configs']]
full_cpus = os.sched_getaffinity(0)  # the unit's whole CPU set: in-run evaluations get it back
if a.env_cpus:
    os.sched_setaffinity(0, cpu_list(a.env_cpus) & full_cpus)  # the environment processes inherit this at spawn
# P10: training seeds from 1e9, far from every evaluation range (7e6 + config index x 1e6)
envs = [NodeEnv({'envs': a.envs, 'configs': STAGES[0]['configs'], 'seed': 1_000_000_000 + 10_000_000 * (i + 1), 'envSeed': 1000 + i,
                 'humans': 'random', 'legacyMates': a.legacy_mates, 'rehearsal': a.rehearsal, 'reward': reward_over,
                 'obsVersion': 3 if 'bands' in spec['blocks'] else 2,
                 'check': a.check, 'shaping': {'gamma': a.gamma, 'wTier': a.shape_tier, 'wStack': a.shape_stack},
                 **({'snapCollect': {'prob': a.snap_collect}, 'snapStart': {'frac': a.snap_start}} if a.snap_start > 0 else {}),
                 **({'bandPolicy': {'share': a.band_policy}} if a.band_policy > 0 else {}),
                 **({'bossRehearsal': a.boss_rehearsal} if a.boss_rehearsal is not None else {})}, node=a.node)
        for i in range(a.procs)]
env_cpu_count = len(os.sched_getaffinity(0))
if a.learner_cpus:
    os.sched_setaffinity(0, cpu_list(a.learner_cpus) & full_cpus)
env_counts = [(0, 0, 0)] * len(envs)  # errors + failed, rejected, violations (batch header) per environment process
Rw = envs[0].spec['reward']
board = Board(os.path.join(a.out, 'tb'), envs[0].spec['act'],
              {k: v for k, v in (x.split('=', 1) for x in a.eval_baselines.split(',') if x)})
# S3 PLR: per process, seed -> {score, last}; trajectory scores (mean |advantage|) gathered over updates
proc_seed_base = [1_000_000_000 + 10_000_000 * (i + 1) for i in range(a.procs)]
levels = [dict() for _ in range(a.procs)]; traj_score = defaultdict(lambda: [0.0, 0]); last_matches = [0] * a.procs
plr_stats = {'replayed': 0, 'fresh': 0}
plr_rng = np.random.default_rng(11)

def plr_pick(i):
    L = levels[i]
    if not L:
        return None
    seeds = list(L.keys()); sc = np.array([L[x]['score'] for x in seeds]); st = np.array([update_no - L[x]['last'] for x in seeds], dtype=np.float64)
    rank = np.empty(len(sc)); rank[np.argsort(-sc)] = np.arange(1, len(sc) + 1)
    ps = (1.0 / rank) ** (1.0 / a.plr_beta); ps /= ps.sum()
    pc = st / st.sum() if st.sum() > 0 else np.full(len(st), 1.0 / len(st))
    p = (1 - a.plr_staleness) * ps + a.plr_staleness * pc
    s_ = seeds[int(plr_rng.choice(len(seeds), p=p / p.sum()))]; L[s_]['last'] = update_no
    return s_

def plr_add(i, seed, score):
    L = levels[i]
    e = L.get(seed)
    L[seed] = {'score': score if e is None else 0.5 * (e['score'] + score), 'last': e['last'] if e else update_no}
    if len(L) > a.plr_buffer:
        del L[min(L, key=lambda x: L[x]['score'])]

# S2 SIL: transitions whose return beat the value estimate, prioritised by (R - V)+
sil = {'obs': None, 'mask': None, 'act': None, 'ret': None, 'pri': None, 'n': 0, 'pos': 0}

def sil_add(obs_np, mask_np, act_np, ret_np, v_np):
    pos_ = ret_np - v_np
    sel = pos_ > 0
    if not sel.any():
        return
    o, m_, ac, r_, pr = obs_np[sel], mask_np[sel], act_np[sel], ret_np[sel], pos_[sel]
    if sil['obs'] is None:
        cap = a.sil_buffer
        sil.update(obs=np.zeros((cap,) + o.shape[1:], np.float16), mask=np.zeros((cap,) + m_.shape[1:], bool), act=np.zeros(cap, np.int64),
                   ret=np.zeros(cap, np.float32), pri=np.zeros(cap, np.float32))
    cap = len(sil['act'])
    for j in range(len(ac)):
        k = sil['pos']; sil['obs'][k] = o[j]; sil['mask'][k] = m_[j]; sil['act'][k] = ac[j]; sil['ret'][k] = r_[j]; sil['pri'][k] = pr[j]
        sil['pos'] = (k + 1) % cap; sil['n'] = min(cap, sil['n'] + 1)

recent_terms = []  # episodes ended since the last update: (config, win, fa, round term, lp term, bond shaping)
BOND = envs[0].spec['blocks']['bonds']  # tier field 2 = tier / 3
G0 = envs[0].spec['blocks']['global']['offset']  # field 0 = round / 15
assert envs[0].spec['dataId'] == spec['dataId'], ('observation layout changed since the checkpoint', envs[0].spec['dataId'], spec['dataId'])
env_stage = [0] * len(envs)
pool = AsyncPool(envs); pool.reset()
pending, chains = {}, defaultdict(list)
ready = 0
episodes = deque(maxlen=3000)
steps = 0; t0 = time.time(); next_ckpt = a.ckpt_every; next_eval = a.eval_every; update_no = 0
gen = torch.Generator(device=dev); gen.manual_seed(7)
evals = []

def finalize(key, r, nv, done):
    global ready
    t = pending.pop(key); t['r'] = r; t['nv'] = nv; t['done'] = done; chains[key].append(t); ready += 1

def rolling(key):
    xs = [e for e in episodes if e[0].endswith(':' + key)]
    if not xs:
        return None
    return {'n': len(xs), 'win': float(np.mean([e[1] for e in xs])), 'survival': float(np.mean([e[2] for e in xs])), 'lp': float(np.mean([e[3] for e in xs])),
            'fa': float(np.mean([e[4] for e in xs]))}

def checkpoint(tag):
    path = os.path.join(a.out, f'model-{tag}.pt')
    save(path, net, {'steps': steps, 'stage': STAGES[stage]['name'], 'args': vars(a)})
    save(os.path.join(a.out, 'model-last.pt'), net, {'steps': steps, 'stage': STAGES[stage]['name'], 'args': vars(a)})
    return path

def launch_eval(path, block=False):
    out = os.path.join(a.out, f'eval-{steps}.json')
    cmd = [sys.executable, os.path.join(os.path.dirname(__file__), 'eval.py'), '--ckpt', path, '--out', out, '--greedy',
           '--matches', str(a.eval_matches), '--chunks', str(a.eval_chunks), '--envs', '6', '--node', a.node,
           '--configs', a.eval_configs, '--rehearsal', str(a.rehearsal), '--device', a.device] + (['--boss-rehearsal', str(a.boss_rehearsal)] if a.boss_rehearsal is not None else [])
    p = subprocess.Popen(cmd, stdout=open(out + '.log', 'w'), stderr=subprocess.STDOUT,
                         env={**os.environ, 'OMP_NUM_THREADS': '4'}, preexec_fn=lambda: os.sched_setaffinity(0, full_cpus))
    evals.append((p, out))
    if block:
        p.wait()

def eval_steps_of(path):
    try:
        return int(os.path.basename(path).split('-')[1].split('.')[0])
    except Exception:
        return 0

def eval_problems():
    """Finished in-run evaluations: (path, rule violations, errors) of each one with a problem; finished ones are dropped."""
    bad = []
    for p, out in list(evals):
        if p.poll() is None:
            continue
        evals.remove((p, out))
        try:
            r = json.load(open(out))['configs']
        except Exception as e:
            bad.append((out, 'unreadable', str(e)[:200])); continue
        viol = sum(int(c['ai'].get('rl', {}).get('violations', 0)) for c in r.values())
        errs = sum(int(c['errors']) for c in r.values())
        summary = {k: {'win': round(c['teamWin'], 3), 'survival': round(c['roles'].get('rl', {}).get('survival', 0), 2),
                       'fa': round(c.get('faShare', 0), 3), 'rt': round(c['ai'].get('rl', {}).get('roundTripsPerPrep', 0), 3)} for k, c in r.items()}
        emit(event='eval', path=out, violations=viol, errors=errs, result=summary)
        board.eval(out)
        if a.www:  # the HTML report of this evaluation (eval_report.py, numpy only; failures never stop training)
            try:
                import eval_report
                base = {k: json.load(open(v)) for k, v in (x.split('=', 1) for x in a.eval_baselines.split(',') if x) if os.path.exists(v)}
                label = {'teacher': '规则版 legacy', 'live': '无规则 legacy'}
                name = f'{os.path.basename(a.out)}-{eval_steps_of(out)}'
                eval_report.add(a.www, name, f'{os.path.basename(a.out)} 训练中评估 · {eval_steps_of(out) / 1e6:.1f}M 步',
                                [(os.path.basename(a.out), json.load(open(out)))], [(label.get(k, k), v) for k, v in base.items()],
                                note=f'贪心策略，rehearsal {a.rehearsal}' + (f'，首领回合 {a.boss_rehearsal}' if a.boss_rehearsal is not None else '') +
                                     f'，每个配置 {a.eval_matches} 个种子')
            except Exception as e:
                emit(event='www-error', path=out, error=str(e)[:300])
        if viol or errs:
            bad.append((out, viol, errs))
    return bad

def update(rollout):
    """One PPO update on `rollout` (trajectory key -> finalized transitions), handed over by the main loop."""
    global update_no
    keys = list(rollout.keys())
    obs, mask, act, logp_old, v_old, adv, ret = [], [], [], [], [], [], []
    kinds, preps = [], []  # preps: (buys, sells, refreshes) of every prep that ended (END) in this rollout
    for key in keys:
        ch = rollout.pop(key)
        cnt = [0, 0, 0]
        for t in ch:
            if t['kind'] != 0:
                continue
            x = t['a']
            if x == board.act['END']:
                preps.append(tuple(cnt)); cnt = [0, 0, 0]
            elif x == board.act['REFRESH']:
                cnt[2] += 1
            elif board.act['BUY'] <= x < board.act['SELL']:
                cnt[0] += 1
            elif board.act['SELL'] <= x < board.act['REWARD']:
                cnt[1] += 1
        a_next = 0.0
        advs = np.empty(len(ch), dtype=np.float32)
        for k in range(len(ch) - 1, -1, -1):
            t = ch[k]
            nd = 0.0 if t['done'] else 1.0
            delta = t['r'] + a.gamma * nd * t['nv'] - t['v']
            a_next = delta + a.gamma * a.lam * nd * a_next
            advs[k] = a_next
        if a.plr > 0:
            ts = traj_score[key]; ts[0] += float(np.abs(advs).sum()); ts[1] += len(advs)
        for t, ad in zip(ch, advs):
            obs.append(t['obs']); mask.append(t['mask']); act.append(t['a']); logp_old.append(t['logp']); v_old.append(t['v'])
            adv.append(ad); ret.append(ad + t['v']); kinds.append(t['kind'])
    extra = {'act': np.array(act), 'kind': np.array(kinds), 'v': np.array(v_old, dtype=np.float32), 'adv': np.array(adv, dtype=np.float32),
             'preps': np.array(preps, dtype=np.int32).reshape(-1, 3)}
    obs_np = np.stack(obs)
    O = torch.from_numpy(obs_np).to(dev).float(); M = torch.from_numpy(np.stack(mask)).to(dev)
    # own bond tiers (Σ active tiers) at prep decisions, by round: does the shaping change the builds
    pk = np.array(kinds) == 0
    tiers = (obs_np[pk][:, BOND['offset'] + 2:BOND['offset'] + BOND['count'] * BOND['width']:BOND['width']].astype(np.float32) * 3).sum(1)
    rounds = np.rint(obs_np[pk][:, G0].astype(np.float32) * 15).astype(int)
    Ac = torch.tensor(act, device=dev, dtype=torch.long); V0 = torch.tensor(v_old, device=dev); R = torch.tensor(ret, device=dev)
    AD_raw = torch.tensor(adv, device=dev)
    N = O.shape[0]
    # groups: difficulty one-hot (global fields 4..7) x solo / co-op (global field 8)
    gnp = obs_np[:, G0 + 4:G0 + 8].astype(np.float32).argmax(1) * 2 + (obs_np[:, G0 + 8] > 0.5)
    G = torch.from_numpy(gnp.astype(np.int64)).to(dev)
    diag = {}
    # P9: the old log-probabilities from the stored (fp16) observations, so the first epoch starts at ratio 1; the same
    # pass gives the rollout policy's entropy per decision kind and per chosen action type (B1)
    with torch.no_grad():
        lps, ents = [], []
        for i in range(0, N, 8192):
            lg, _ = net(O[i:i + 8192], M[i:i + 8192]); la = F.log_softmax(lg, 1)
            lps.append(la.gather(1, Ac[i:i + 8192, None]).squeeze(1)); ents.append(-(la.exp() * la).sum(1))
        LP = torch.cat(lps); ENT = torch.cat(ents)
        LP_rec = torch.tensor(logp_old, device=dev)
        diag['diag/logp_fp16_gap'] = float((LP - LP_rec).abs().mean())
        if a.overlap:  # T1: samples were drawn by an actor up to one update older than this net: keep the recorded log-probs
            LP = LP_rec
    ent_np = ENT.cpu().numpy(); kinds_np = np.array(kinds)
    types = np.searchsorted(np.array(board.bounds), np.array(act), side='right')
    for kname, kv in (('prep', 0), ('card', 1)):
        sel = kinds_np == kv
        if sel.any():
            diag[f'diag/entropy_kind_{kname}'] = float(ent_np[sel].mean())
    for ti, tname in enumerate(TYPES):
        sel = types == ti
        if sel.any():
            diag[f'diag/entropy_chosen_{tname}'] = float(ent_np[sel].mean())
    r_np, v_np, adv_np = np.array(ret, np.float64), np.array(v_old, np.float64), np.array(adv, np.float64)
    def explained(sel):
        var = r_np[sel].var()
        return float(1 - (r_np[sel] - v_np[sel]).var() / var) if var > 1e-12 else float('nan')
    diag['diag/ev_all'] = explained(np.ones(N, bool)); diag['diag/adv_std_all'] = float(adv_np.std())
    for gi, gname in enumerate(GROUPS):
        sel = gnp == gi
        if sel.sum() >= 32:
            diag[f'diag/ev_{gname}'] = explained(sel); diag[f'diag/adv_std_{gname}'] = float(adv_np[sel].std())
            diag[f'diag/samples_{gname}'] = int(sel.sum())
    # advantage normalisation: one batch-wide scale, or per group (A3 switch; a group under 32 samples uses the batch's)
    gm, gs = AD_raw.mean(), AD_raw.std() + 1e-8
    if a.adv_norm == 'group':
        AD = (AD_raw - gm) / gs
        for gi in range(len(GROUPS)):
            sel = G == gi
            if int(sel.sum()) >= 32:
                x = AD_raw[sel]; AD[sel] = (x - x.mean()) / (x.std() + 1e-8)
    else:
        AD = (AD_raw - gm) / gs
    # bc_kl_steps <= 0: a persistent anchor (ppo2: 0.01 towards the init policy, ppo1-final)
    bc_coef = 0.0 if bc_net is None else a.bc_kl if a.bc_kl_steps <= 0 else a.bc_kl * max(0.0, 1.0 - steps / a.bc_kl_steps)
    warm = update_no < a.vf_warmup
    TB = None
    if band_fa is not None and update_no < a.band_warm_steps:
        selb = kinds_np == 2
        if selb.any():
            TB = torch.zeros((N, a_dim := np.stack(mask).shape[1]), device=dev)
            TB[torch.from_numpy(np.flatnonzero(selb)).to(dev)] = torch.from_numpy(band_targets(obs_np, np.stack(mask), selb)).to(dev)
            diag['diag/band_warm_rows'] = int(selb.sum())
    info = defaultdict(list); stop = False
    for ep in range(a.epochs):
        perm = torch.randperm(N, device=dev)
        for i in range(0, N, a.minibatch):
            idx = perm[i:i + a.minibatch]
            logits, v = net(O[idx], M[idx])
            if a.vclip > 0:
                vc = V0[idx] + (v - V0[idx]).clamp(-a.vclip, a.vclip)
                vl = 0.5 * torch.max((v - R[idx]) ** 2, (vc - R[idx]) ** 2).mean()
            else:
                vl = 0.5 * ((v - R[idx]) ** 2).mean()  # A2: no value clipping (unnormalised returns)
            if warm:
                # A1: only the value head learns; the shared trunk and so the policy stay as initialised
                net.zero_grad(set_to_none=True); (a.vf * vl).backward()
                torch.nn.utils.clip_grad_norm_(value_params, 0.5); opt_v.step()
                info['vloss'].append(vl.item())
                continue
            logp_all = F.log_softmax(logits, 1)
            logp = logp_all.gather(1, Ac[idx, None]).squeeze(1)
            logratio = logp - LP[idx]; ratio = torch.exp(logratio)
            pg = -torch.min(ratio * AD[idx], ratio.clamp(1 - a.clip, 1 + a.clip) * AD[idx]).mean()
            p = logp_all.exp()
            ent = -(p * logp_all).sum(1).mean()
            loss = pg + a.vf * vl - a.ent * ent
            if TB is not None:  # Step 2 warm start: the band head towards the Step 0 table on band rows
                tb = TB[idx]; has = tb.sum(1) > 0
                if has.any():
                    lb_ = -(tb[has] * logp_all[has].clamp_min(-1e4)).sum(1).mean(); loss = loss + lb_; info['band_warm_ce'].append(lb_.item())
            if bc_coef > 0:
                with torch.no_grad():
                    lb, _ = bc_net(O[idx], M[idx]); lpb = F.log_softmax(lb, 1)
                kl_bc = (lpb.exp() * (lpb - logp_all)).sum(1).mean()
                loss = loss + bc_coef * kl_bc; info['kl_bc'].append(kl_bc.item())
            opt.zero_grad(set_to_none=True); loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 0.5); opt.step()
            with torch.no_grad():
                kl1 = (-logratio).mean().item(); kl3 = ((ratio - 1) - logratio).mean().item()  # P6: k3, non-negative
                cf = ((ratio - 1).abs() > a.clip).float().mean().item()
            for k_, v_ in (('pg', pg.item()), ('vloss', vl.item()), ('ent', ent.item()), ('kl', kl1), ('kl3', kl3), ('clipfrac', cf)):
                info[k_].append(v_)
            if kl3 > 1.5 * a.target_kl:
                stop = True; break
        if stop:
            break
    extra['diag'] = diag
    if a.sil > 0 and not warm:
        sil_add(obs_np, np.stack(mask), np.array(act), np.array(ret, np.float32), np.array(v_old, np.float32))
        if sil['n'] >= a.minibatch:
            pri = sil['pri'][:sil['n']] + 1e-6; p = pri / pri.sum(); sl = []
            for _ in range(a.sil_batches):
                idx = np.random.choice(sil['n'], size=a.minibatch, p=p)
                so = torch.from_numpy(sil['obs'][idx]).to(dev).float(); sm = torch.from_numpy(sil['mask'][idx]).to(dev)
                sa = torch.from_numpy(sil['act'][idx]).to(dev); sr = torch.from_numpy(sil['ret'][idx]).to(dev)
                lg, sv = net(so, sm); lpa = F.log_softmax(lg, 1).gather(1, sa[:, None]).squeeze(1)
                clipped = (sr - sv).clamp_min(0)
                loss = a.sil * (-(lpa * clipped.detach()).mean() + a.sil_vf * 0.5 * (clipped ** 2).mean())
                opt.zero_grad(set_to_none=True); loss.backward(); torch.nn.utils.clip_grad_norm_(net.parameters(), 0.5); opt.step()
                sl.append(loss.item())
            diag['diag/sil_loss'] = float(np.mean(sl)); diag['diag/sil_buffer'] = int(sil['n'])
    update_no += 1
    extra['tiers'] = tiers; extra['rounds'] = rounds
    return N, {k: round(float(np.mean(v)), 5) for k, v in info.items()}, ep + 1, bc_coef, extra

# Step 2: band-head warm start from the Step 0 table (band_table.json): target = softmax(fa(config, band) / tau) over legal bands
band_fa = None
if a.band_warmstart:
    _t = json.load(open(a.band_warmstart))
    _bl = sorted(json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../data/bands.json'))).keys())[:40]
    band_fa = {cfg: np.array([{r['band']: r['fa'] for r in v['bands']}.get(b, np.nan) for b in _bl], dtype=np.float64) for cfg, v in _t.items()}

def band_targets(obs_np, mask_np, sel):
    """(rows, A) targets for band-decision rows `sel`; the config from the observation (difficulty one-hot, co-op flag)."""
    A0 = envs[0].spec['act']['BAND']; out = np.zeros((int(sel.sum()), mask_np.shape[1]), np.float32)
    for r, k in enumerate(np.flatnonzero(sel)):
        diff = ('FUNNY', 'NORMAL', 'HARD', 'ABYSS')[int(obs_np[k, G0 + 4:G0 + 8].astype(np.float32).argmax())]
        key = ('coop4' if obs_np[k, G0 + 8] > 0.5 else 'solo') + ':' + diff
        fa = band_fa.get(key)
        legal = mask_np[k, A0:A0 + 40]
        if fa is None or not legal.any():
            continue
        v = np.where(legal & np.isfinite(fa), fa, np.nan); v = np.where(np.isfinite(v), v, np.nanmin(v) if np.isfinite(v).any() else 0)
        z = np.exp((v - v[legal].max()) / a.band_tau) * legal; out[r, A0:A0 + 40] = z / z.sum()
    return out

emit(event='start', init=a.init, params=sum(p.numel() for p in net.parameters()), thresholds=threshold, args=vars(a),
     learner_cpus=len(os.sched_getaffinity(0)), env_cpus=env_cpu_count, unit_cpus=len(full_cpus), stages=[s['name'] for s in STAGES])
last_log = time.time(); sps_steps = 0; sps_t = time.time()
t_sel = t_fwd = 0.0; prev_update = time.time()
upd_thread = None; upd_box = {}; lag_steps = 0  # main-loop time in select waits / forward passes since the last update
while steps < a.max_steps and time.time() - t0 < a.hours * 3600:
    ts = time.time(); batch_list = list(pool.poll(timeout=60)); t_sel += time.time() - ts
    for i, b in batch_list:
        for tid, tr, info in zip(b.term_ids, b.term_rew, b.term_info):
            key = (i, int(tid))
            if key in pending:
                finalize(key, float(tr), 0.0, True)
            ci = int(info[3]); names = [c['name'] for c in STAGES[env_stage[i]]['configs']]
            if a.plr > 0:
                ts = traj_score.pop(key, None)
                if ts and ts[1]:
                    plr_add(i, proc_seed_base[i] + int(round(float(info[8]))), ts[0] / ts[1])
            name = names[ci] if ci < len(names) else '?'
            episodes.append((name, float(info[0]), float(info[1]), float(info[2]), float(info[4])))
            recent_terms.append((name, float(info[0]), float(info[4]), float(info[5]), float(info[6]), float(info[7])))
        env_counts[i] = (b.errors, b.rejected, b.violations)
        if a.plr > 0:  # matches opened since this process's last batch: a share of them replays a buffered level
            opened = b.matches - last_matches[i]; last_matches[i] = b.matches; queue = []
            for _ in range(max(0, opened)):
                if plr_rng.random() < a.plr:
                    s_ = plr_pick(i)
                    if s_ is not None:
                        queue.append(s_); plr_stats['replayed'] += 1; continue
                plr_stats['fresh'] += 1
            if queue:
                envs[i].set_configs(seeds=queue)
        if env_stage[i] != stage:
            envs[i].set_configs(STAGES[stage]['configs']); env_stage[i] = stage
        if b.n == 0:
            pool.step(i, np.zeros(0, dtype=np.int32)); continue
        tf = time.time()
        with torch.no_grad():
            logits, v = actor(torch.from_numpy(np.array(b.obs)).to(dev), torch.from_numpy(np.array(b.mask)).to(dev))
            probs = torch.softmax(logits, 1)
            acts = torch.multinomial(probs, 1, generator=gen).squeeze(1)
            lp = torch.log(probs.gather(1, acts[:, None]).squeeze(1).clamp_min(1e-12))
        acts_np = acts.int().cpu().numpy(); lp_np = lp.cpu().numpy(); v_np = v.cpu().numpy(); t_fwd += time.time() - tf
        for k in range(b.n):
            key = (i, int(b.ids[k]))
            if key in pending:
                finalize(key, float(b.rew[k]), float(v_np[k]), False)
            pending[key] = {'obs': b.obs[k].astype(np.float16), 'mask': b.mask[k].copy(), 'a': int(acts_np[k]), 'logp': float(lp_np[k]), 'v': float(v_np[k]),
                            'kind': int(b.kinds[k])}
        pool.step(i, acts_np)
        steps += b.n; sps_steps += b.n
    if a.overlap and upd_thread is not None:
        if upd_thread.is_alive() and ready < 2 * a.rollout:
            continue  # keep collecting while the learner works (at most one rollout ahead)
        upd_thread.join()
        with torch.no_grad():
            actor.load_state_dict(net.state_dict())  # the actor catches up with the learner
        n, info, epochs_done, bc_coef, extra = upd_box['result']; upd_s = upd_box['seconds']; upd_thread = None
        lag_steps = steps - upd_box['steps_at_start']
    elif ready >= a.rollout and a.overlap:
        upd_box = {'steps_at_start': steps}
        rollout_, chains, ready = chains, defaultdict(list), 0  # the learner gets its own rollout; collection goes on
        def _run():
            t_ = time.time(); upd_box['result'] = update(rollout_); upd_box['seconds'] = time.time() - t_
        upd_thread = threading.Thread(target=_run, daemon=True); upd_thread.start()
        continue
    elif ready >= a.rollout:
        rollout_, chains, ready = chains, defaultdict(list), 0
        tu = time.time(); n, info, epochs_done, bc_coef, extra = update(rollout_); upd_s = time.time() - tu; lag_steps = 0
    else:
        continue
    if True:
        interval = max(1e-6, time.time() - prev_update); prev_update = time.time()
        loop = {'diag/stall_ratio': (0.0 if a.overlap else upd_s) / interval, 'diag/frac_select_wait': t_sel / interval,
                'diag/frac_forward': t_fwd / interval, 'diag/policy_lag_steps': lag_steps}
        if a.plr > 0:
            tot_ = plr_stats['replayed'] + plr_stats['fresh']
            loop.update({'diag/plr_replay_share': plr_stats['replayed'] / max(1, tot_), 'diag/plr_levels': sum(len(L) for L in levels),
                         'diag/plr_score_mean': float(np.mean([e['score'] for L in levels for e in L.values()] or [0]))})
        t_sel = t_fwd = 0.0
        st = STAGES[stage]; roll = rolling(st['key'])
        emit(event='update', update=update_no, steps=steps, sps=round(sps_steps / max(1e-6, time.time() - sps_t)), samples=n, epochs=epochs_done,
             update_s=round(upd_s, 2), bc_coef=round(bc_coef, 4), stage=st['name'], stage_steps=steps - stage_since,
             rolling={k: rolling(k) for k in ('NORMAL', 'HARD', 'ABYSS')}, hours=round((time.time() - t0) / 3600, 3),
             env_errors=sum(c[0] for c in env_counts), env_rejected=sum(c[1] for c in env_counts), env_violations=sum(c[2] for c in env_counts),
             warmup=update_no <= a.vf_warmup, ev=round(extra['diag'].get('diag/ev_all', float('nan')), 4),
             stall=round(loop['diag/stall_ratio'], 4), **info)
        board.update(steps, {'sps': sps_steps / max(1e-6, time.time() - sps_t), 'update_s': upd_s, 'bc_coef': bc_coef, 'samples': n,
                             'epochs': epochs_done, 'stage': stage, 'warmup': float(update_no <= a.vf_warmup),
                             'env_errors': sum(c[0] for c in env_counts), 'env_rejected': sum(c[1] for c in env_counts),
                             'env_violations': sum(c[2] for c in env_counts), **info, **extra['diag'], **loop},
                     {k: rolling(k) for k in ('NORMAL', 'HARD', 'ABYSS')}, recent_terms, Rw,
                     extra if update_no % a.hist_every == 0 else None, bonds=(extra['tiers'], extra['rounds']))
        recent_terms.clear()
        bad = eval_problems()
        if sum(c[0] for c in env_counts) or sum(c[2] for c in env_counts) or bad:
            path = checkpoint(f'{int(steps)}-alert')
            emit(event='alert', steps=steps, env_errors=sum(c[0] for c in env_counts), env_violations=sum(c[2] for c in env_counts),
                 evals=bad, checkpoint=path)
            break
        sps_steps = 0; sps_t = time.time()
        # curriculum
        if stage < len(STAGES) - 1:
            in_stage = steps - stage_since
            thr = threshold.get(st['key'], 0.8 if st['key'] == 'NORMAL' else 0.4)
            if (in_stage >= a.stage_min and roll and roll['n'] >= 500 and roll['win'] >= thr) or in_stage >= a.stage_max:
                stage += 1; stage_since = steps; episodes.clear()
                emit(event='stage', stage=STAGES[stage]['name'], steps=steps, reason='threshold' if in_stage < a.stage_max else 'max-steps', rolling=roll, threshold=thr)
        if steps >= next_ckpt:
            path = checkpoint(f'{int(steps)}'); next_ckpt += a.ckpt_every
            if steps >= next_eval:
                launch_eval(path); next_eval += a.eval_every
if upd_thread is not None:  # T1: the last overlapped update finishes before the final checkpoint
    upd_thread.join()
path = checkpoint('final')
emit(event='end', steps=steps, hours=round((time.time() - t0) / 3600, 3), stage=STAGES[stage]['name'])
launch_eval(path, block=True)
for p, _ in list(evals):
    p.wait()
eval_problems()
board.close()
pool.close()
