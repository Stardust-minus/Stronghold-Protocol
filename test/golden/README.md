# Golden results

The simulation is deterministic: the same seed and inputs give the same battle and the same match, bit for bit. These
files record the exact outcome of a fixed corpus of seeded scenarios, so a change that alters gameplay — even one meant
to be a pure refactor that only reorders random draws, hook order or iteration order — fails loudly instead of slipping
through.

- `tools/golden.mjs` builds the corpus from `data/*.json` (fixed order, fixed seeds) and reduces every scenario to a
  digest. Its header documents the families and the digest fields.
- `test/golden/<family>.json` hold the digests (`roster`, `bonds`, `fields`, `matches`, `standins`, `diy`).
- `test/golden.test.js` recomputes them and compares. On a mismatch it prints the scenario, the field and old → new.

## The corpus

| family | what runs |
|---|---|
| `roster` | 49 battles: every visible chess record (normal and elite) with every selectable skill and module (DESIGN §16), 12 operators per battle on a real stage (all 11 in turn) against the round's real wave three times over, every non-leader enemy kind of `data/enemies.json` as extra spawns (half of them bounties), placeable summons on the board, every equipment item, band, battle-side 机变 card and stage map card in turn, bonds from the board |
| `bonds` | 46 battles: every bond at its activation threshold (1 layer) and at its top tier (999 layers) |
| `fields` | 22 battles: every Final Assault / Hidden Core leader on a pair and a solo template (shared pool, 200 s cap) and the 联防 field with 1 and 2 helpers on the round's stage, both halves (carried HP / SP, a knocked-out operator, two leakers' enemies) |
| `matches` | Full matches in virtual time: bot-only solo and co-op, server-run combat, boosted Hidden Core runs, partially owned human rosters and a human with no NORMAL operators (AI 托管, offline; `standIns` records the fielded stand-ins per round), and human 自选 picks with 调度中心 level 5 from the first prep (`diy` records shop draws and deployed pieces). `matchScenarios()` lists every configuration. |
| `standins` | 10 battles: every NORMAL chess record (normal and elite, 110) fielded as its 补位 stand-in (`standIn: true`: the stand-in's body, backup skill / module and kit — all 17 stand-ins, every skill a chess names for them), 12 per battle by strength band, laid out by the stand-in's position on a real stage, against the round's real wave three times over plus 8 ground enemy kinds (melee stand-ins always meet an enemy), an item each, bonds from the board |
| `diy` | battles of 自选 pieces (a DIY slot with its `diy` pick, `shared/diy.js`): every owned 6★ with an operator kit (`kits/index.js OPERATOR_KITS`) in each form of tiers 5 and 6 (normal; elite with no module and with each module) under each skill, then every prototype pick with a kit at its locked selection, normal and elite, 12 per battle against the round's real wave; a new operator kit adds its scenarios (the battle count grows with the kits) |

Battles go through the production BattleSpec path (`server/sim/spec.js`, as browsers and the server's headless fields
run them); matches construct `Match` directly with a `VirtualScheduler`. Every option is explicit, so a change to a
test-harness default never moves a digest.

What a digest ignores on purpose (it does not affect gameplay): object key order, engine unit ids (snapshot ids are
renumbered by first appearance, units are named by board uid or def id), board piece uids, the order of client events
within a tick (they are counted, not hashed) and wall-clock time. Damage / healing sums are rounded to integers and HP
to 2 decimals.

`npm test` runs the fast subset: the scenarios marked `"fast": true` in the golden files, selected by `isFast` in
`tools/golden.mjs`. `GOLDEN_FULL=1` checks everything. Use the listing commands below to inspect the current corpus
and fast subset.

## Stardust fork baseline

The fork's leader pool follows upstream's per-player rule again (since 2026-10-12): co-op is bloodPoint × the players alive when the fight starts (at most four), solo × 1. Only an opt-in room of more than four seats goes past four (`server/match/finalAssault.js bossPoolHp`); no scenario of the corpus has such a room; `test/match/experimental-player-capacity.test.js` covers it. `tools/golden.mjs` still supplies the official Boss configuration explicitly, so a change of the live config never moves a digest.

The root corpus (the six families, 291 scenarios) is upstream 0.3.3's 288 plus this fork's intended gameplay changes, each regenerated with `npm run golden:update` in the commit that made it (2026-11-02 to 11-05: the 自选 kits of 塔露拉, 冻河 and 国度 grew `diy` by 3 scenarios — its battles are batches of 12 pieces, so the new forms also shift later batches — and with the fork's rule and kit changes 26 existing scenarios moved; the other 262 keep upstream's digests). The historical-version corpora were regenerated when the later 6★ 自选 operators joined those versions (rel26). Never regenerate these JSON files to hide a fork/default mismatch.

The virtual-time goldens do not replace native Worker/trial, ordered-event/10Hz transport or human-revival tests.

## Workflow

```sh
node tools/golden.mjs --list                     # list the current corpus without running it
node tools/golden.mjs --fast --list              # list only the fast subset
GOLDEN_FULL=1 node --test test/golden.test.js   # the whole corpus (≈ 20 s with 4 worker threads)
node --test test/golden.test.js                 # the fast subset
npm run golden                                  # the same comparison from the tool (all families, a short report)
npm run golden:update                           # recompute and rewrite test/golden/*.json
node tools/golden.mjs --twice                   # determinism: the corpus twice in one process, the second pass reversed
```

- **A refactor commit must never change these files.** Run `GOLDEN_FULL=1 node --test test/golden.test.js` before
  committing it. If a digest moves, the refactor changed behaviour: find out why (the first differing value of `snaps`
  says when two runs parted, in 10-game-second steps) instead of updating the files.
- **An intended gameplay change** (a fix, new content, a data rebuild): run `npm run golden:update` and commit the
  changed files together with the change, saying in the commit message which scenarios moved and why. Until the
  official versions' M1 started, `test/versions-default-guard.test.js` (G1) also pinned the sha256 of these files and
  of the default `data/*.json` as the M0 merge check (DESIGN §35.22.2); M1 deleted it (§35.23), so these files and
  `test/golden.test.js` are the only pin again.
- **Reviewing the diff:** every scenario is a block of its own and every unit / enemy / round is one line, so a diff
  shows which scenarios moved and which values changed. A change confined to the scenarios that contain the touched
  operator, enemy or rule is expected; a change everywhere (every `rngDraws`, every `snaps`) means something global
  moved — the RNG draw order, the tick order, a shared rule.
- **Adding to the corpus** (a new family, more scenarios, a new digest field) changes the files by design: do it in a
  commit of its own, never together with a refactor.
- A new engine hook, event or chess record does not change the digests of the existing scenarios by itself — the
  hook list is frozen in the tool and the corpus is regenerated only on `golden:update` — but new data records do join
  the corpus there (the roster family enumerates `data/chess.json`).

The original stand-in / DIY seeds remain as outcome regressions even when they field no such operator. The
`coop2-NORMAL-1-unowned-roster` scenario supplies no owned NORMAL operators, so stand-in coverage does not depend on
the bot choosing one of a small set of missing operators. `coop2-NORMAL-5-coverage-diy` covers the DIY path.

Historical versions (0.3.2 M2): pass `--version <official-id>` to use the snapshot in an isolated process/worker.
The six corpora live under `<versionSlug>/`; root JSON files remain the default. Generate a historical corpus with
`node tools/golden.mjs --version act1autochess --update --twice`; the second pass reverses scenario order.
`test/versions-golden.test.js` checks corpus identity, engine errors and representative worker execution.
