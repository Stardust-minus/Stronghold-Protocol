# tools/rl — reinforcement learning for the AI seats (development tool, not part of a release)

The environment drives ordinary `Match`es through the bot-strategy `decide` hook. Every action goes through the same
validation as a human intent, and the legacy planner still places the lineup. The policy sees only what that seat's
player sees (public view, private view, prep scout, static catalogue). Nothing here changes the game for players. The one
change outside this folder is a gated line in `server/match/bot.js` (`ps._envPlanBonds`, set only by `env.mjs` for human
proxies in training) that lets legacy pursue an announced bond plan.

Comments that cite `plan §…` refer to the maintainers' design notes; what a contributor needs is summarised here.

## Where it stands (2026-11-12)

- Game data `act2autochess`, observation `dataId` `act2autochess-b0c30136ef88` (version 2: 920 inputs, 60 actions).
- The policy runs the prep economy: buy, sell, refresh, level, freeze, rewards, 机变 cards. Legacy places the lineup.
- Network (`py/model.py`): 1.32 M parameters. Embeddings and per-kind entity encoders, mean + max pooling, an MLP
  trunk, pointer heads over the candidates, a value head. The entities do not interact.
- Pipeline:
  - 4.8 M demonstrations from the rule-enforcing legacy teacher (`record.mjs`);
  - behaviour cloning (bc1);
  - PPO ppo1, 3e7 steps;
  - ppo2 starts from ppo1. It adds a whole-team Final Assault damage reward, a KL anchor of 0.01 to ppo1 and
    potential-based bond shaping. It was stopped at 1.5e7 steps for a retrain that brings the items below together.
- Team win rate. Same 96 seeds per config, greedy, `--rehearsal 0 --boss-rehearsal 3`:

| config | production legacy | teacher (legacy + AI-seat rules) | ppo2 at 1.5e7 |
|---|---|---|---|
| solo:HARD | 0.344 | 0.344 | 0.719 |
| solo:ABYSS | 0.010 | 0.010 | 0.042 |
| coop4:HARD | 0.521 | 0.406 | 0.865 |
| coop4:ABYSS | 0.062 | 0.031 | 0.021 |

Production legacy ignores the AI-seat rules: it takes the humans' main bond, 707 violations in coop4:HARD. That is why
it beats the teacher in coop4. ABYSS (终极模拟) is the open problem.

## Reproduce

- Node 24.
- Python 3.12, PyTorch 2.x (ours: 2.15 with CUDA), numpy, tensorboard.
- The environments are CPU-bound: 60 processes on 64 cores collect about 2.7 k steps/s. A GPU helps the updates and
  BC.
- Every script's docstring and `--help` list the switches.

```sh
node tools/rl/record.mjs --out data --tag s1 --matches 400 --seed 100000 --envs 8     # BC shards (data/<dataId>/)
python tools/rl/py/train_bc.py --data data/<dataId> --out runs/bc
python tools/rl/py/train_ppo.py --init runs/bc/bc.pt --out runs/ppo --procs 24 --envs 16
E="--greedy --matches 96 --rehearsal 0 --boss-rehearsal 3 --configs solo:HARD,solo:ABYSS,coop4:HARD,coop4:ABYSS"
python tools/rl/py/eval.py --teacher --out runs/base/teacher.json $E
python tools/rl/py/eval.py --legacy --out runs/base/live.json $E
python tools/rl/py/eval.py --ckpt runs/ppo/model-last.pt --out runs/ppo/eval.json $E
python tools/rl/py/compare.py <dir> REF:RUN                                               # paired, per seed
python tools/rl/py/export.py --ckpt runs/ppo/model-last.pt --out runs/ppo/policy          # for infer.mjs / infer2.mjs
```

## What a deployable model must keep

- **It runs on the player's device.** The model is downloaded and evaluated in the browser in plain JS, with no
  third-party runtime. Size is not the limit; compute is.
- **≤ 10 ms per decision on a mid-range phone.** We measure this with Chrome CPU throttling 4× (`chrome_bench.mjs`).
  `infer2.mjs` takes 2.4 ms at 4× and 3.6 ms at 6×. WebGPU only if a model outgrows the CPU path.
- **Bit-identical in every JS engine.** The server falls back to the same code and checks results by hash, so:
  - keep a fixed operation order;
  - use + − × ÷, comparisons and `Math.sqrt` only, never `Math.exp` / `log` / `tanh` / `pow` (the engines may round
    them differently);
  - a layer that needs exp (an attention softmax) gets a fixed polynomial in plain arithmetic;
  - sampling is the argmax of the logits plus server-supplied noise.
- **Only what that seat's player can see.** The observation is the public view, the private view, the prep scout and
  the static catalogue.
- **A model reads only its own `dataId`.** Another game version needs its own data and model; `vcheck.mjs` guards
  this.

## Open problems (contributions welcome)

1. **ABYSS**: about 2–4 % wins. The Final Assault pool share (`fa`) is the dense signal. Legacy still chooses the lineup
   and the boss-round placement: let the policy pick the lineup, or pick among legacy's candidate placements.
2. **Identical shop cards encode identically**: there is no slot index, so BC cannot tell twins apart. bc1 validation
   accuracy is 0.80 (buy 0.68, sell 0.58). Measure twin-aware / equivalence-class accuracy (`twin.py`) before blaming
   capacity.
3. **The BC value head overfits**: validation value error rises while training error falls, and the trunk is shared
   with the policy. A separate, larger critic? PPG-style updates?
4. **Capacity or missing information?** `bc_probe.py` / `model2.py` compare:
   - 2× / 4× width;
   - a residual LayerNorm trunk;
   - entity attention;
   - bond look-ahead features for the candidates.
5. **Band (opening strategy) choice**: a band strength table from paired seeds (`band_table.py`), then PPO. Avoid
   bands whose bond a human already plays or plans.
6. **Fewer forward passes and round trips per prep**:
   - update the first layer incrementally between consecutive decisions;
   - batch several AI seats in one forward;
   - skip the forward when one action is legal;
   - send one batch of intents per shop state;
   - encode once per shop state, then run a light decoder per action.

To propose a change:
- evaluate it on the same seeds against the teacher and production legacy, and compare with `compare.py`
  (`fa` for ABYSS, win rate for HARD);
- if the forward changes, include `chrome_bench.mjs` numbers;
- run the checks below.

## Environment (Node)

| File | |
|---|---|
| `spec.mjs` | observation / action layout (version 2 = ppo1/ppo2; version 3 = + boss / teammates' bond bars and plans + band choice), masks, AI-seat rules (让主盟约 `yieldMain`, 让合成 `yieldMerge`, card-pool settings), band conflicts |
| `env.mjs` | `SPEnv`: N matches per process in virtual time; `reset()` / `step(actions)`; rewards (round, LP, win, Final Assault pool share `fa`, team weighting, potential-based bond shaping); modes `policy` / `teacher` (legacy procurement as env actions, optional rule enforcement) / `legacy`; rule metrics and round-trip log; late-game checkpoint starts (S1, `snapCollect` / `snapStart`); explicit seed queue (PLR); band choice with human proxies; per-round CPU timing |
| `server.mjs` | the environment behind a binary stdin/stdout protocol (frame format in its header) |
| `describe.mjs` | readable decision states (Chinese catalogue names) for the replay viewer |
| `record.mjs` | behaviour-cloning shards from the rule-enforcing legacy teacher |
| `infer.mjs` | plain-JS forward pass of an exported policy (reference) |
| `infer2.mjs` | exact rewrite of `infer.mjs` (folded embeddings, skipped absent rows / masked actions, split pointer heads): same outputs, ~4x fewer MACs |
| `viewer.html` | static per-round replay viewer (policy and legacy side by side) |

## Python (PyTorch)

| File | |
|---|---|
| `py/spenv.py` | client: `NodeEnv`, `AsyncPool` |
| `py/model.py`, `py/model2.py` | policy / value network; `model2` = architecture-probe variants (width, residual LayerNorm trunk, entity self-attention) |
| `py/data.py`, `py/train_bc.py` | shard reader, behaviour cloning |
| `py/train_ppo.py` | PPO: asynchronous collection, GAE, curricula / fixed mixes, KL anchor, value-only warm-up, group advantage normalisation, overlap of update and collection, PLR, SIL, late-game starts, band choice, TensorBoard (`tb.py`) |
| `py/eval.py`, `py/compare.py`, `py/stats.py` | same-seed evaluation of a checkpoint / the teacher / production legacy; paired comparison (fa: mean, IQM, bootstrap CI; win: Wilson, McNemar) |
| `py/eval_report.py`, `py/replay.py` | self-contained HTML evaluation pages; decision replays for `viewer.html` |
| `py/export.py`, `py/parity.py` | export for the JS forward and its parity check |
| `py/surgery.py` | function-preserving growth of a checkpoint into a newer observation layout (zero-initialised new inputs) |
| `py/kl_drift.py`, `py/twin.py`, `py/bc_probe.py`, `py/band_table.py`, `py/tb_from_jsonl.py` | diagnostics: drift by decision kind, label ambiguity, architecture probe, band strength table, TensorBoard from logs |

## Checks

Run heavy jobs through your machine's job queue, not on a shared host directly.

```sh
node tools/rl/smoke.mjs --matches 4 --configs coop4:HARD,solo:NORMAL --humans 1   # random policy + teacher == legacy
node tools/rl/vcheck.mjs                    # observation versions (v2 must keep the ppo2 dataId)
node tools/rl/bandtest.mjs                  # band choice: masks, conflicts, fallbacks
node tools/rl/snaptest.mjs --matches 4      # late-game checkpoints restore and finish exactly like the originals
node tools/rl/parity2.mjs <policy base>     # infer2.mjs == infer.mjs on real observations
node tools/rl/chrome_bench.mjs <policy base> 1500 <chrome>  # ms per decision, Chrome CPU throttling 1x/4x/6x
python tools/rl/py/surgery.py --ckpt old.pt --out new.pt  # parity of the grown network
```

Status: band choice (Step 1), band warm start (Step 2: `--band-warmstart`), SIL, PLR, update overlap and the
architecture probe are experimental, smoke-tested only.
Record layout of `record.mjs`: f16 obs[D] · u8 mask bits[⌈A/8⌉] · u8 action · u8 kind · u16 0 · u32 trajectory · f32 reward
since the trajectory's previous record; trajectory ends in `<tag>.terms.jsonl`, the spec in `<tag>.meta.json`.
