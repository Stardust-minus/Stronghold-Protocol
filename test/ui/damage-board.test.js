import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { damageNumber, damageRows, damageShare, acceptDamageSnapshot, uniteDamageOwners, bossDamageOwners, damageGroups } from '../../public/js/ui/damageBoard.js';
import { emptyMatch } from '../../public/js/store.js';
import { PHASE } from '../../shared/constants.js';

const packet = (round = 2, status = 'live') => ({ matchId: 'game', round, status, owners: [
  { playerId: 'p1', operators: [{ key: 'op1', uid: 1, defId: 'a', damage: 100 }, { key: 'op2', uid: 2, defId: 'a', damage: 250 }], otherDamage: 50 },
  { playerId: 'p2', operators: [{ key: 'op3', uid: 3, defId: 'b', damage: 10 }], otherDamage: 0 },
] });

test('ranked output follows selected owner and keeps two same operators separate', () => {
  const p = packet(), before = structuredClone(p);
  assert.deepEqual(damageRows(p, 'p1').rows.map(r => [r.key, r.damage]), [['op2', 250], ['op1', 100], ['other', 50]]);
  assert.equal(damageRows(p, 'p1').total, 400);
  assert.deepEqual(damageRows(p, 'p2').rows.map(r => r.key), ['op3']);
  assert.equal(damageRows(p, 'p2').total, 10);
  assert.equal(damageRows(p, 'unknown').available, false);
  assert.deepEqual(p, before, 'selector cannot mutate stored/frozen values');
});

const unitePublic = () => ({ phase: PHASE.UNITE, round: 2,
  players: [{ playerId: 'p1', name: '左侧博士' }, { playerId: 'p2', name: '右侧博士' }, { playerId: 'leaker', name: '漏怪博士' }],
  fields: [{ fieldId: 'u', kind: 'unite', players: ['p1', 'p2'] }],
});

test('the displayed unite field selects both helpers, not the leaker or every owner in the ledger', () => {
  const pub = unitePublic(), before = structuredClone(pub);
  const owners = uniteDamageOwners({ pub, fieldId: 'u' });
  assert.deepEqual(owners, [{ playerId: 'p1', name: '左侧博士' }, { playerId: 'p2', name: '右侧博士' }]);
  const snap = packet(); snap.owners.push({ playerId: 'leaker', operators: [{ uid: 8, damage: 9999 }], total: 9999 });
  const score = damageGroups(snap, owners);
  assert.equal(score.shared, true);
  assert.equal(score.available, true);
  assert.equal(score.total, 410);
  assert.deepEqual(score.groups.map(group => group.playerId), ['p1', 'p2']);
  assert.deepEqual(pub, before);
});

test('unite grouping stays off in normal/prep/Boss phases even with stale unite metadata', () => {
  const pub = unitePublic(), field = { fieldId: 'u', players: ['p1', 'p2'], round: 2 };
  for (const phase of [PHASE.PREP, PHASE.COMBAT, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE, PHASE.RESULT]) {
    assert.equal(uniteDamageOwners({ pub: { ...pub, phase }, fieldId: 'u', field }), null);
  }
  for (const fieldId of [null, 'n:p1', 'n:p2', 'b1', 'b2']) assert.equal(uniteDamageOwners({ pub, fieldId, field }), null);
  assert.equal(uniteDamageOwners({ pub: { ...pub, fields: [{ fieldId: 'u', kind: 'normal', players: ['p1', 'p2'] }] }, fieldId: 'u', field }), null);
});

test('settle retains the displayed unite members but next PREP does not reuse that field', () => {
  const pub = { ...unitePublic(), phase: PHASE.SETTLE, fields: [] };
  const field = { fieldId: 'u', players: ['p1', 'p2'], round: 2 };
  assert.equal(uniteDamageOwners({ pub, fieldId: 'u', field }).length, 2);
  assert.equal(uniteDamageOwners({ pub, fieldId: 'u', field: { ...field, round: 1 } }), null);
  assert.equal(uniteDamageOwners({ pub: { ...pub, phase: PHASE.PREP, round: 3 }, fieldId: 'u', field }), null);
});

test('single/duplicate/unknown helpers cannot duplicate totals or expand to unrelated owners', () => {
  const pub = unitePublic();
  pub.fields[0].players = ['p2', 'p2', 'unknown'];
  const owners = uniteDamageOwners({ pub, fieldId: 'u' });
  assert.deepEqual(owners, [{ playerId: 'p2', name: '右侧博士' }]);
  assert.equal(damageGroups(packet(), owners).shared, false);
  assert.equal(damageGroups(packet(), [...owners, ...owners]).total, 10);
  pub.fields[0].players = ['p1', 'p2', 'leaker'];
  assert.equal(uniteDamageOwners({ pub, fieldId: 'u' }), null, 'a malformed field never widens the two-helper roster');
});

const bossPublic = (hidden = false) => ({ phase: hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT, round: hidden ? 15 : 14,
  players: ['p1', 'p2', 'p3', 'p4'].map((playerId, i) => ({ playerId, name: `博士${i + 1}` })),
  fields: [{ fieldId: 'b1', kind: hidden ? 'hidden' : 'boss', players: ['p1', 'p2'] },
    { fieldId: 'b2', kind: hidden ? 'hidden' : 'boss', players: ['p3', 'p4'] }],
});

test('Boss and hidden Boss select only both actual players in the displayed field, independent of camera half', () => {
  for (const hidden of [false, true]) {
    const pub = bossPublic(hidden), before = structuredClone(pub);
    const owners = bossDamageOwners({ pub, fieldId: 'b1' });
    assert.deepEqual(owners.map(p => p.playerId), ['p1', 'p2']);
    assert.deepEqual(bossDamageOwners({ pub, fieldId: 'b1', ownerId: 'p2' }), owners);
    assert.deepEqual(bossDamageOwners({ pub, fieldId: 'b2' }).map(p => p.playerId), ['p3', 'p4']);
    const snap = packet(pub.round); snap.owners.push({ playerId: 'p3', total: 9999 }, { playerId: 'p4', total: 8888 });
    const score = damageGroups(snap, owners);
    assert.equal(score.shared, true); assert.equal(score.available, true); assert.equal(score.total, 410);
    assert.deepEqual(score.groups.map(g => g.playerId), ['p1', 'p2']);
    assert.deepEqual(pub, before);
  }
});

test('Boss grouping fails closed for another phase, absent field, wrong kind or stale field metadata', () => {
  const pub = bossPublic(), field = { ...pub.fields[0], round: 14 };
  for (const phase of [PHASE.PREP, PHASE.COMBAT, PHASE.UNITE, PHASE.SETTLE, PHASE.RESULT]) {
    assert.equal(bossDamageOwners({ pub: { ...pub, phase }, fieldId: 'b1', field }), null);
  }
  for (const fieldId of [null, '', 'u', 'n:p1', 'b3']) assert.equal(bossDamageOwners({ pub, fieldId, field }), null);
  assert.equal(bossDamageOwners({ pub: { ...pub, fields: [] }, fieldId: 'b1', field }), null);
  assert.equal(bossDamageOwners({ pub: { ...pub, phase: PHASE.HIDDEN_CORE, round: 15 }, fieldId: 'b1', field }), null);
  assert.equal(bossDamageOwners({ pub: { ...bossPublic(true), phase: PHASE.FINAL_ASSAULT }, fieldId: 'b1' }), null);
  assert.deepEqual(bossDamageOwners({ pub: bossPublic(true), fieldId: 'b2', field }).map(p => p.playerId), ['p3', 'p4'], 'current public roster wins over retired metadata');
});

test('Boss single-player groups, duplicate IDs and unavailable partners keep honest totals', () => {
  const pub = bossPublic();
  pub.fields[1].players = ['p3', 'p3', 'unknown'];
  const owners = bossDamageOwners({ pub, fieldId: 'b2' });
  assert.deepEqual(owners, [{ playerId: 'p3', name: '博士3' }]);
  assert.equal(damageGroups({ owners: [{ playerId: 'p3', total: 50 }] }, owners).shared, false);
  const pair = bossDamageOwners({ pub, fieldId: 'b1' });
  const snap = { ...packet(14, 'frozen'), owners: packet().owners.slice(0, 1) };
  const score = damageGroups(snap, pair);
  assert.equal(score.available, false); assert.equal(score.groups[0].available, true); assert.equal(score.groups[1].available, false);
  assert.equal(damageGroups({ ...packet(14), available: false }, pair).available, false);
  pub.fields[0].players.push('p3');
  assert.equal(bossDamageOwners({ pub, fieldId: 'b1' }), null);
});

test('player groups isolate same operator UID/key and other damage, with per-player percentages', () => {
  const snap = { owners: [
    { playerId: 'p1', operators: [{ key: 'same', uid: 1, defId: 'a', damage: 60 }], otherDamage: 40 },
    { playerId: 'p2', operators: [{ key: 'same', uid: 1, defId: 'a', damage: 10 }], otherDamage: 10 },
  ] };
  const before = structuredClone(snap);
  const score = damageGroups(snap, uniteDamageOwners({ pub: unitePublic(), fieldId: 'u' }));
  assert.deepEqual(score.groups.map(group => [group.total, group.rows.map(row => row.key)]), [[100, ['same', 'other']], [20, ['other', 'same']]]);
  assert.equal(damageShare(60, score.groups[0].total), 60);
  assert.equal(damageShare(10, score.groups[1].total), 50);
  assert.equal(score.total, 120);
  assert.deepEqual(snap, before);
});

test('missing or unavailable partner statistics are not presented as a complete zero contribution', () => {
  const owners = uniteDamageOwners({ pub: unitePublic(), fieldId: 'u' });
  const snap = packet(); snap.owners = snap.owners.slice(0, 1);
  const score = damageGroups(snap, owners);
  assert.equal(score.available, false);
  assert.equal(score.groups[0].available, true);
  assert.equal(score.groups[1].available, false);
  assert.equal(damageGroups({ ...packet(), available: false }, owners).available, false);
  assert.equal(damageGroups(null, []).available, false);
});

test('current match/round cannot be overwritten by stale data or a late live snapshot after freeze', () => {
  const live = packet(), frozen = packet(2, 'frozen');
  assert.strictEqual(acceptDamageSnapshot(null, live, 'game'), live);
  assert.strictEqual(acceptDamageSnapshot(live, frozen, 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, packet(1), 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, live, 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, { ...live, matchId: 'old' }, 'game'), frozen);
  assert.strictEqual(acceptDamageSnapshot(frozen, { ...live, round: NaN }, 'game'), frozen);
  const next = packet(3); assert.strictEqual(acceptDamageSnapshot(frozen, next, 'game'), next);
  assert.strictEqual(acceptDamageSnapshot(null, live, null), null);
});

test('unavailable client/hidden-group data is not mislabeled zero damage and numbers stay bounded', () => {
  assert.equal(damageRows({ ...packet(), available: false }, 'p1').available, false);
  for (const n of [undefined, NaN, Infinity, -1]) assert.equal(damageNumber(n), '0');
  assert.equal(damageNumber(999), '999'); assert.equal(damageNumber(12345), '1.23万'); assert.equal(damageNumber(1e8), '1.00亿');
  assert.equal(emptyMatch().damage, null);
});

test('scoreboard defaults collapsed, keeps the single-owner fallback and receives displayed unite/Boss membership', () => {
  const component = readFileSync(new URL('../../public/js/ui/damageBoard.js', import.meta.url), 'utf8');
  assert.match(component, /open = false/);
  assert.match(component, /snapshot\?\.status === 'frozen'/);
  const game = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.match(game, /\[damageOpen, setDamageOpen\] = useState\(false\)/);
  assert.match(game, /<\$\{DamageBoard\} snapshot=\$\{damage\} units=\$\{shownOps\} ownerId=\$\{strip\.ownerId\}/);
  assert.match(game, /const shownOps = \[\.\.\.\(field\?\.units \|\| \[\]\), \.\.\.spawnedOps\]/, 'portraits use visible metadata and late-spawned operators from this field');
  assert.match(game, /uniteDamageOwners\(\{ pub, fieldId: stripFid, field \}\)/);
  assert.match(game, /uniteOwners=\$\{uniteOwners\}/);
  assert.match(game, /bossDamageOwners\(\{ pub, fieldId: stripFid \}\)/);
  assert.match(game, /bossOwners=\$\{bossOwners\} bossHidden=\$\{pub\?\.phase === PHASE\.HIDDEN_CORE\}/);
  assert.match(component, /隐藏 Boss 输出/);
  assert.match(component, /同场玩家本轮累计/);
  assert.match(component, /不等同于全队共享 Boss 血池扣血/);
  assert.match(component, /open \? damageGroups\(snapshot, owners\) : null/);
  assert.match(component, /key=\$\{group\.playerId\}/);
  assert.match(component, /本人占比/);
  assert.match(readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8'), /\/css\/screens\/damage-board\.css/);
});

test('damage toggle is one icon with the same compact control and touch target classes', () => {
  const component = readFileSync(new URL('../../public/js/ui/damageBoard.js', import.meta.url), 'utf8');
  const toggle = component.match(/<button[^]*?damage-board__toggle[^]*?<\/button>/)?.[0];
  assert.ok(toggle);
  assert.match(toggle, /gm__gear tapx damage-board__toggle/);
  assert.equal([...toggle.matchAll(/<\$\{Icon\}/g)].length, 1);
  assert.doesNotMatch(toggle, /<span>|chevron/);
  assert.match(toggle, /aria-expanded/);
  const css = readFileSync(new URL('../../public/css/screens/damage-board.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.damage-board__toggle > \.icon:last-child/);
});

test('damage shares are bounded and preserve the server snapshot', () => {
  assert.equal(damageShare(25, 100), 25);
  assert.equal(damageShare(250, 100), 100);
  for (const [damage, total] of [[-1, 10], [Infinity, 10], [10, 0], [10, Infinity], [NaN, 1]]) assert.equal(damageShare(damage, total), 0);
});

test('the report lives beside toolbar controls and cannot remain expanded over the emote picker', () => {
  const game = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  const corner = game.slice(game.indexOf('<div class="gm__corner">'), game.indexOf('${drawer ? html`<${EnemyDrawer}'));
  assert.match(corner, /<\$\{DamageBoard\}/);
  assert.ok(corner.includes('setEmoteOpen(open); if (open) setDamageOpen(false)'));
  assert.ok(corner.includes('setDamageOpen(open); if (open) setEmoteOpen(false)'));
  assert.match(game, /else if \(L\.damageOpen\) setDamageOpen\(false\)/);
});

test('expanded rows reuse manifest avatars, accessible exact-value tooltips and numeric shares', () => {
  const component = readFileSync(new URL('../../public/js/ui/damageBoard.js', import.meta.url), 'utf8');
  assert.ok(component.indexOf('src=${chessAvatarUrl(manifest, chess)}') > component.indexOf('open ? html`'));
  assert.match(component, /<\$\{Tooltip\} text=\$\{detail\}/);
  assert.match(component, /tabIndex="0" aria-label=\$\{detail\}/);
  assert.match(component, /share\.toFixed\(1\)/);
  assert.match(component, /aria-label=\$\{t\('输出统计'\)\}/);
});
