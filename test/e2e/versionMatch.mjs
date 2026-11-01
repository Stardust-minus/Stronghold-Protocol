// E2E helper: the Match of a version host in a browser test (startServer matchHost.matchModule; test/e2e/fastServer.mjs
// SP_VERSION_MATCH_MODULE). test/ui/version-local-replica.e2e.test.js: the match jumps to the round before the Final
// Assault, the humans get a few of the version's cheap operators placed by the bots' planner, so one browser run sees a
// normal battle and a boss battle with units on them. Not a test file.
import { Match as RealMatch } from '../../server/match/Match.js';
import { legalTiles, placeClass, tileKey } from '../../server/match/board.js';
import { planLayout } from '../../server/match/bot.js';

const KIT = 6;

export class Match extends RealMatch {
  startRound(r) {
    if (this._jumped) { super.startRound(r); return; }
    this._jumped = true;
    super.startRound(Math.max(r, this.gd.bossRound - 1));
    for (const ps of this.alivePlayers()) if (!ps.isBot) this._kit(ps);
    this._placeRound = this.round;
  }

  _kit(ps) {
    const all = Object.values(this.data.chess || {}).filter((c) => c && c.visible && !c.isGolden && c.tier <= 3)
      .sort((a, b) => (b.tier - a.tier) || String(a.chessId).localeCompare(String(b.chessId)));
    for (const rec of all.slice(0, KIT)) {
      const slot = ps.hand.findIndex((x) => x == null);
      if (slot < 0) break;
      const base = this.gd.baseIdOf(rec.chessId);
      ps.hand[slot] = ps.newPiece('chess', rec.chessId, { poolCopies: ps.poolOf(base).take(base, 1) });
    }
    ps.recompute();
  }

  enterPrep() {
    super.enterPrep();
    if (this._placeRound !== this.round) return;
    this._placeRound = null;
    for (const ps of this.alivePlayers()) {
      if (ps.isBot) continue;
      const pieces = ps.hand.filter((p) => p && p.kind === 'chess');
      const plan = planLayout(this, ps, pieces);
      for (const piece of pieces) {
        const key = plan?.get(piece.uid);
        if (key) {
          const [row, col] = key.split(',').map(Number);
          const res = ps.move(piece.uid, { area: 'board', row, col }, plan.dirs.get(piece.uid) || 'RIGHT');
          if (!res?.error) continue;
        }
        for (const [row, col] of legalTiles(ps.deployMap(), placeClass(ps, this.gd.chess(piece.id)))) {
          if (ps.board.has(tileKey(row, col))) continue;
          if (!ps.move(piece.uid, { area: 'board', row, col }, 'RIGHT')?.error) break;
        }
      }
      ps.recompute();
      ps.dirty();
    }
    this.markPublic();
  }
}
