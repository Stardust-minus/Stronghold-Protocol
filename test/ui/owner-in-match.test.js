// 服主 in the match (rel32, the owner's request of 2026-11-04 「服主特效做进对局内也显示，并且更显眼高级一点」): a match player is
// the owner while the room.state the client holds marks its seat or spectator seat (public/js/ui/ownerName.js
// isOwnerPlayer). Display only — the match DTO, its checkpoint and a version host never carry it — so a restored room, the
// 掉线接管 of the owner's seat and a spectator all follow the room alone; an AI seat never shows it. The browser check of
// the room, the roster, the battle, the spectator and the result is test/ui/owner-mark.e2e.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOwnerPlayer, isOwnerSeat } from '../../public/js/ui/ownerName.js';
import { restoreLobby, LOBBY_DOC_VERSION } from '../../server/persist/lobbyState.js';
import { SessionRegistry } from '../../server/net.js';
import { Lobby } from '../../server/lobby.js';

const src = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const ROOM = {
  code: 'ABCD', inMatch: true,
  seats: [
    { seat: 0, playerId: 'p_owner', name: 'Stardust', isBot: false, owner: true },
    { seat: 1, playerId: 'p_mate', name: '阿米娅', isBot: false },
    // the server never marks an AI seat; a frame that did is still not shown
    { seat: 2, playerId: 'ai_1', name: 'AI·华法琳', isBot: true, owner: true },
    null,
  ],
  spectators: [{ playerId: 'sp_owner', name: '服主', connected: true, owner: true }, { playerId: 'sp_2', name: '观战者', connected: true }],
};

test('isOwnerPlayer: the owner seat and the owner spectator; nobody else, never an AI', () => {
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'p_owner', isBot: false }), true);
  assert.equal(isOwnerPlayer(ROOM, 'p_owner'), true, 'a bare playerId (the damage board, the bond strip)');
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'p_mate' }), false);
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'ai_1', isBot: true }), false, 'an AI seat');
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'ai_1' }), false, 'an AI seat even when the row does not say isBot');
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'p_owner', isBot: true }), false, 'a row that is an AI is never the owner');
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'sp_owner' }), true, 'a spectator seat');
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'sp_2' }), false);
  assert.equal(isOwnerPlayer(ROOM, { playerId: 'nobody' }), false, 'a player the room does not seat');
  for (const room of [null, undefined, {}, { seats: 'x' }]) assert.equal(isOwnerPlayer(room, { playerId: 'p_owner' }), false);
  for (const p of [null, undefined, {}, { playerId: 7 }, { name: 'Stardust' }, '']) assert.equal(isOwnerPlayer(ROOM, p), false, JSON.stringify(p));
  // never decided from a name: the owner's name on another seat is nothing
  assert.equal(isOwnerPlayer({ seats: [{ seat: 0, playerId: 'x', name: 'Stardust', isBot: false }] }, { playerId: 'x', name: 'Stardust' }), false);
  assert.equal(isOwnerSeat({ owner: true, isBot: true }), false);
});

test('掉线接管: the owner\'s seat played by the AI is still the owner\'s human seat (shown); a pure AI seat is not', () => {
  // m.public players[] while the AI plays the owner's dropped seat: isBot stays false, aiTakeoverRound / offlineTakeover set
  const taken = { playerId: 'p_owner', isBot: false, connected: false, autoplay: true, offlineTakeover: true };
  assert.equal(isOwnerPlayer(ROOM, taken), true);
  // a spectator who took over an AI seat by vote (room.aiVote) holds that playerId as a human: its own mark, not the AI's
  const inherited = { ...ROOM, seats: ROOM.seats.map((s) => (s?.playerId === 'ai_1' ? { ...s, isBot: false, owner: undefined } : s)) };
  assert.equal(isOwnerPlayer(inherited, { playerId: 'ai_1', isBot: false, aiTakeoverRound: 3 }), false);
});

test('restore: a room restored from the lobby document (a restart, a switch) keeps the mark on its seat and spectator seat', () => {
  const registry = new SessionRegistry({ reconnectWindowMs: 600_000 });
  const lobby = new Lobby({ registry, getData: () => ({}) });
  const doc = {
    v: LOBBY_DOC_VERSION, kind: 'local', savedAt: 0,
    sessions: [
      { playerId: 'p_owner', token: 'a'.repeat(32), name: 'Stardust', roomCode: 'ABCD', connected: true, disconnectedAt: null },
      { playerId: 'p_mate', token: 'b'.repeat(32), name: '阿米娅', roomCode: 'ABCD', connected: true, disconnectedAt: null },
      { playerId: 'sp_owner', token: 'c'.repeat(32), name: '服主', roomCode: 'WXYZ', connected: true, disconnectedAt: null },
      { playerId: 'p_host2', token: 'd'.repeat(32), name: 'Host', roomCode: 'WXYZ', connected: true, disconnectedAt: null },
    ],
    rooms: [
      { code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 4 },
        hostId: 'p_owner', matchCount: 1, seats: [{ seat: 0, playerId: 'p_owner', name: 'Stardust', isBot: false, owner: true },
          { seat: 1, playerId: 'p_mate', name: '阿米娅', isBot: false }, { seat: 2, playerId: 'ai_1', name: 'AI', isBot: true }, null],
        spectators: [], match: { kind: 'local', id: 'L.ABCD.1.1', seed: 1, matchNo: 1 } },
      { code: 'WXYZ', mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 4 },
        hostId: 'p_host2', matchCount: 0, seats: [{ seat: 0, playerId: 'p_host2', name: 'Host', isBot: false }, null, null, null],
        spectators: [{ playerId: 'sp_owner', name: '服主', owner: true }], match: null },
    ],
  };
  const out = restoreLobby({ doc, registry, lobby, now: 1000 });
  assert.equal(out.sessions, 4);
  const state = lobby.rooms.get('ABCD').toState(1000);
  assert.equal(isOwnerPlayer(state, { playerId: 'p_owner' }), true, 'the in-match room after a restart');
  assert.equal(isOwnerPlayer(state, { playerId: 'p_mate' }), false);
  assert.equal(isOwnerPlayer(state, { playerId: 'ai_1', isBot: true }), false);
  const other = lobby.rooms.get('WXYZ').toState(1000);
  assert.equal(isOwnerPlayer(other, { playerId: 'sp_owner' }), true, 'the spectator seat');
  lobby.shutdown();
});

test('display only: the match never carries the mark (its DTO, its public players, the cluster plan)', () => {
  const views = src('server/match/match/views.js');
  const players = views.slice(views.indexOf('players: this.order.map((ps) => ({'), views.indexOf('fields: this.fields.map('));
  assert.ok(players.length > 100 && !/owner/.test(players), 'm.public players[] has no owner field');
  assert.match(src('server/cluster/lobby.js'), /const stampMember = member => \{ if \(!member\) return member; const \{ card, owner, \.\.\.rest \} = member; return rest; \};/);
});

test('every in-match surface reads it from the room (ui/ownerName.js); the look (lobby.css) is a still, flat accent', () => {
  const uses = {
    'public/js/ui/gameComponents.js': /<\$\{OwnerAvatarFx\} player=\$\{player\} \/>/, // every match avatar
    'public/js/ui/teamPanel.js': /<\$\{MatchName\} player=\$\{p\} class="team__name"/,
    'public/js/ui/hud.js': /<\$\{MatchName\} player=\$\{s\} class="spec__name" \/>/,
    'public/js/ui/combatHud.js': /<\$\{MatchName\} player=\$\{p\} tag="b"/,
    'public/js/ui/damageBoard.js': /<\$\{MatchName\} player=\$\{\{ playerId: group\.playerId \}\}/,
    'public/js/ui/danmaku.js': /<\$\{MatchName\} player=\$\{first \|\| \{ playerId: x\.pids\[0\] \}\}/,
    'public/js/ui/choiceOverlay.js': /<\$\{MatchName\} player=\$\{p \|\| \{ playerId: pid \}\}/,
    'public/js/ui/bondStrip.js': /<\$\{OwnerMark\} player=\$\{ownerId\} \/>/,
    'public/js/screens/result.js': /<b class="rcard__name"><\$\{MatchName\} player=\$\{p\}/,
    'public/js/screens/settle.js': /<\$\{MatchName\} player=\$\{p\} name=\$\{p\.name\} \/>/,
    'public/js/screens/room.js': /<span class="rseat__ownertag" data-owner-tag="1"/,
    // the strategy draft's order (选择策略, the user's 「选策略界面的服主标记显示不正常」: only the avatar was marked) and the reroll vote
    'public/js/screens/bandDraft.js': /<b class="dorder__name">[^\n]*<\$\{MatchName\} player=\$\{p\} name=\$\{p\.name \|\| t\('博士'\)\} \/>/,
    'public/js/ui/setupReroll.js': /<\$\{MatchName\} player=\$\{p \|\| \{ playerId: id \}\}/,
  };
  for (const [file, re] of Object.entries(uses)) assert.match(src(file), re, file);
  // the user's 「对局内只有一个皇冠，玩家会不会不知道是服主」: every in-match name carries the full 「♛ 服主」 tag, never the crown alone
  for (const file of Object.keys(uses)) assert.doesNotMatch(src(file), /<\$\{(?:MatchName|OwnerMark|OwnerBadge)\}[^>]*(?:badge="compact"|compact=\$\{true\}|badge=\$\{false\})/, file);
  const owner = src('public/js/ui/ownerName.js');
  assert.match(owner, /aria-label=\$\{compact \? label : undefined\}/, 'a crown alone still says 服主');
  assert.match(owner, /<span class="sp-owner-line">/, 'the name and its tag stay on one line');
  const css = src('public/css/screens/lobby.css');
  const look = css.slice(css.indexOf('/* ---- 服主 (ui/ownerName.js'), css.indexOf('.set-owner {')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['.sp-owner-name', '.sp-owner-badge', '.sp-owner-badge--compact', '.sp-owner-fx', '.team__row.is-sp-owner .team__info', '.rseat.is-owner .rseat__strip',
    '.rseat__ownertag', '.rseat.is-owner .rseat__plate::after', '.tcard.is-sp-owner .tcard__plate', '.rcard.is-sp-owner', '.dorder__name .sp-owner-badge',
    '.dorder .sp-owner-fx { inset: 0; border: 0; box-shadow: 0 0 0 .03rem var(--sp-own); }', '.dband__who .sp-owner-fx']) assert.ok(look.includes(sel), sel);
  // the owner's 「简约高级一点」 (v2): nothing moves or glows, no gradient text — reduced motion needs nothing of its own
  for (const banned of ['animation', '@keyframes', '@property', 'text-shadow', 'drop-shadow', 'background-clip', 'conic-gradient', ':has(']) {
    assert.ok(!look.includes(banned), banned);
  }
  assert.match(look, /--sp-own: #e6c27a;/);
});
