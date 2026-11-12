"""End-to-end throughput: K Node environment processes driven by one Python process (AsyncPool), random legal actions.
python bench_random.py --procs 24 --envs 16 --seconds 60 --configs solo:NORMAL,coop4:NORMAL [--lockstep]"""
import argparse, time
import numpy as np
from spenv import NodeEnv, AsyncPool, masked_random

ap = argparse.ArgumentParser()
ap.add_argument('--procs', type=int, default=4)
ap.add_argument('--envs', type=int, default=16)
ap.add_argument('--seconds', type=float, default=30)
ap.add_argument('--configs', default='solo:NORMAL')
ap.add_argument('--rehearsal', type=int, default=0)
ap.add_argument('--node', default='node')
ap.add_argument('--lockstep', action='store_true')
ap.add_argument('--humans', default='random')
a = ap.parse_args()
rng = np.random.default_rng(1)
envs = [NodeEnv({'envs': a.envs, 'configs': a.configs.split(','), 'seed': 1 + 100000 * i, 'envSeed': 7 + i,
                 'rehearsal': a.rehearsal, 'humans': a.humans if a.humans == 'random' else int(a.humans)}, node=a.node) for i in range(a.procs)]
print('spec dim', envs[0].spec['dim'], 'actions', envs[0].spec['actions'], flush=True)
steps = terms = 0
py_s = 0.0
last = {}
if a.lockstep:
    for e in envs:
        e.reset_async()
    batches = [e.wait() for e in envs]
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < a.seconds:
        for e, b in zip(envs, batches):
            p0 = time.perf_counter(); acts = masked_random(b.mask, rng); py_s += time.perf_counter() - p0
            e.step_async(acts); steps += b.n
        batches = [e.wait() for e in envs]
        terms += sum(len(b.term_ids) for b in batches)
    last = {i: b.matches for i, b in enumerate(batches)}
else:
    pool = AsyncPool(envs)
    pool.reset()
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < a.seconds:
        for i, b in pool.poll():
            terms += len(b.term_ids); last[i] = b.matches
            p0 = time.perf_counter(); acts = masked_random(b.mask, rng); py_s += time.perf_counter() - p0
            steps += b.n
            pool.step(i, acts)
    for i, b in pool.poll(timeout=30):
        pass
dt = time.perf_counter() - t0
print(f"{'lockstep' if a.lockstep else 'async'} procs {a.procs} envs {a.envs}: {steps} decisions in {dt:.1f} s = {steps / dt:.0f}/s; "
      f"{terms} trajectories ended, {sum(last.values())} matches; python policy time {py_s:.2f} s", flush=True)
for e in envs:
    e.close()
