import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAnnouncements, announcementRevision, announcementDismissed, dismissAnnouncement } from '../../public/js/ui/announcements.js';
import { createDataStore } from '../../public/js/data.js';

const notice = () => ({ title: '本地测试公告', date: '2026-10-05', paragraphs: ['第一段。', '第二段\n保留换行。'] });
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('announcement list preserves editorial order, optional date, text and input isolation', () => {
  const first = notice(), second = { title: '无日期测试', paragraphs: ['<img src=x onerror="alert(1)">'] };
  Object.freeze(first.paragraphs); Object.freeze(first); Object.freeze(second.paragraphs); Object.freeze(second);
  const input = Object.freeze([first, second]);
  const entries = parseAnnouncements(input);
  assert.deepEqual(entries, [{ ...first }, { ...second, date: '' }]);
  assert.notEqual(entries[1], first); assert.notEqual(entries[1].paragraphs, first.paragraphs);
  entries[1].paragraphs.push('只改变返回值'); assert.equal(first.paragraphs.length, 2);
  assert.deepEqual(parseAnnouncements([]), []);
});

test('invalid or oversized announcements are unavailable, never truncated or disguised as empty', () => {
  for (const value of [null, {}, 'text', [null], [{ ...notice(), title: ' ' }], [{ ...notice(), date: 1 }],
    [{ ...notice(), paragraphs: [] }], [{ ...notice(), paragraphs: [' '] }], [{ ...notice(), paragraphs: [1] }],
    [{ ...notice(), title: 'x'.repeat(121) }], [{ ...notice(), date: 'x'.repeat(41) }],
    [{ ...notice(), paragraphs: ['x'.repeat(10001)] }], [{ ...notice(), paragraphs: Array(41).fill('p') }],
    Array(51).fill(notice()), [{ ...notice(), paragraphs: Array(21).fill('x'.repeat(10000)) }]]) {
    assert.equal(parseAnnouncements(value), null, JSON.stringify(value).slice(0, 100));
  }
});

test('announcement content revision is stable, and title/date/text/order updates create a new unread revision', async () => {
  const a = notice(), version = await announcementRevision([a]);
  assert.equal(await announcementRevision([{ paragraphs: a.paragraphs, date: a.date, title: a.title }]), version);
  assert.equal(announcementDismissed(version), false);
  dismissAnnouncement(version);
  assert.equal(announcementDismissed(version), true);
  for (const changed of [{ ...a, title: a.title + '更新' }, { ...a, date: '2026-10-06' }, { ...a, paragraphs: ['更新正文'] }, { ...a, paragraphs: [...a.paragraphs].reverse() }]) {
    const next = await announcementRevision([changed]);
    assert.notEqual(next, version); assert.equal(announcementDismissed(next), false);
  }
  assert.equal(await announcementRevision([]), null);
  assert.equal(await announcementRevision({}), null);
  const fallback = await announcementRevision([a], null);
  assert.equal(fallback, await announcementRevision([a], null));
  assert.notEqual(fallback, await announcementRevision([{ ...a, title: '不同内容' }], null));
});

test('announcement acknowledgement remains effective in-page when browser storage is blocked', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try {
    const version = await announcementRevision([{ title: '无存储测试', paragraphs: ['仍可关闭'] }]);
    dismissAnnouncement(version); assert.equal(announcementDismissed(version), true);
    assert.equal(announcementDismissed(await announcementRevision([notice()])), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage;
  }
});

test('announcement data reuses same-origin optional loading, request deduplication and explicit retry', async () => {
  const calls = [];
  const store = createDataStore({ retryDelays: [], fetch: async (url, opts) => {
    calls.push({ url, cache: opts.cache });
    return calls.length === 1 ? { ok: false, status: 404 } : { ok: true, json: async () => [notice()] };
  } });
  const a = store.load('announcements'), b = store.load('announcements');
  assert.equal(a, b); assert.equal(store.status('announcements'), 'loading');
  assert.equal(await a, null); assert.equal(store.status('announcements'), 'missing');
  assert.deepEqual(await store.invalidate('announcements'), [notice()]);
  assert.equal(store.status('announcements'), 'ready');
  assert.deepEqual(calls, [{ url: '/data/announcements.json', cache: 'no-cache' }, { url: '/data/announcements.json', cache: 'no-cache' }]);
});

test('shipped announcement data validates; optional board is mounted from the lobby only', () => {
  assert.notEqual(parseAnnouncements(JSON.parse(source('../../data/announcements.json'))), null);
  const lobby = source('../../public/js/screens/lobby.js'), board = source('../../public/js/ui/announcements.js');
  assert.match(lobby, /overlay === 'announcements' \? html`<\$\{LobbyAnnouncements\}/);
  assert.match(lobby, /function LobbyAnnouncements\([\s\S]*?useData\('announcements'\)/);
  assert.match(lobby, /data\.status\('announcements'\)/);
  assert.doesNotMatch(board, /useData\(|data\.(?:get|status|load|invalidate)\(/);
  assert.match(board, /暂无公告/); assert.match(board, /暂时无法显示公告/); assert.match(board, /正在读取公告/);
  assert.match(lobby, /data\.invalidate\('announcements'\)/);
  assert.match(board, /onClick=\$\{onRetry\}/);
  assert.doesNotMatch(board, /dangerouslySetInnerHTML|innerHTML|setInterval|net\.request/);
  assert.match(board, /ariaLabel=\$\{t\('大厅公告板'\)\} trapFocus=\$\{true\}/);
});

test('the notices: the 0.4.0 private-run update over the retained 10-06 introduction (the credit and a first-visit guide)', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  // 2026-11-16: the owner cleared every notice but the oldest (「除了最旧的都清掉」) and asked for only the fork's own changes,
  // pointing to the original's 0.4.0 release for the rest (「只写我们的，其余的让用户去看0.4.0就行」). The interface author's
  // contact and the credits of the removed 10-18 recap move here.
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, '版本更新：同步原作 0.4.0，按版本匹配，连接更稳定');
  assert.equal(entries[0].date, '2026-11-16');
  const rel40 = entries[0].paragraphs.join('\n');
  for (const phrase of ['私人运行', '待休赛期再对外开放', 'github.com/sganggs/Stronghold-Protocol/releases/tag/v0.4.0', '只列本服自己的调整',
    '「规程·序列Ⅰ」', '第二期下半', '「选择自编」', '「自选四选二」', '按版本分池', '「多人匹配」', '「组队匹配」', '3 条连接', '1.5 秒',
    '「大厅背景」', '「规程」主题', '红色的无法出现干员数', '「设置 → 界面主题」', '“全能的”可露希尔', '「点击进入」', '「更新说明」弹窗不加',
    '39 套时装', '寰宇独奏', '54 名干员', '15 套动态立绘', '漫步于黄金之梦', 'Touch', '歌利亚', '「反馈板」', '雨千代chiyo', 'xinhai-ai'])
    assert.ok(rel40.includes(phrase), phrase);
  assert.doesNotMatch(rel40, /ModelScope|OpenI|签名|nginx|Worker|WebSocket|lanes|\/feedback|#1[0-9]|ac_s_closur/i);
  // the 10-06 introduction stays untouched (the owner: 「10-06的不能动」)
  assert.equal(entries[1].title, '欢迎游玩卫戍协议！卫来！');
  assert.equal(entries[1].date, '2026-10-06');
  assert.match(entries[1].paragraphs.join('\n'), /纯公益.*非官方/);
  assert.match(entries[1].paragraphs.join('\n'), /github\.com\/sganggs\/Stronghold-Protocol/);
  assert.match(entries[1].paragraphs.join('\n'), /界面致谢：.*Bilibili@雨千代chiyo/);
  assert.match(entries[1].paragraphs.join('\n'), /第一次来的博士：.*「玩法说明」/);
  // condensed on 2026-10-17 (the 0.3.0 notice alone had grown past 3000): the board scrolls, but the notices stay bounded
  assert.ok(entries.flatMap(entry => entry.paragraphs).join('\n').length < 4000, 'the notices stay readable');
});

test('announcements omit contacts and infrastructure', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  const text = entries.flatMap(entry => entry.paragraphs).join('\n');
  // the one contact a notice carries is the interface author's (the owner's request of 2026-10-14)
  assert.deepEqual([...text.matchAll(/QQ\s*(\d+)/g)].map(m => m[1]), ['374360968']);
  assert.doesNotMatch(text.replace('QQ 374360968', ''), /QQ|群号|243859707|815818430|2225664821|coordinator|ingress|Worker|WireGuard|ModelScope|OpenI|\b\d{1,3}(?:\.\d{1,3}){3}\b/);
});

test('topmost modal traps and restores focus and compact matching explains room-owned experimental rules', () => {
  const modal = source('../../public/js/ui/components.js'), matching = source('../../public/js/ui/matchmaking.js');
  const experimental = source('../../public/js/ui/experimental.js'), revival = source('../../public/js/ui/revival.js');
  assert.match(modal, /aria-label=\$\{ariaLabel\}/);
  assert.match(modal, /if \(!topmost\(\)\) return/);
  assert.match(modal, /else if \(e\.key === 'Tab'\)/); assert.match(modal, /prevFocus\?\.focus/);
  assert.match(modal, /window\.addEventListener\('focusin', onFocus\)/);
  assert.match(matching, /compact = false/); assert.match(matching, /compact \? null : html`<small>\$\{t\(MATCHING_RULES\)\}/);
  assert.match(matching, /\$\{t\(MATCHING_RULES\)\}<\/p><p class="modal__text">\$\{t\(EXPERIMENTAL_RULES\)\}/);
  assert.match(matching, /未完成确认者不自动回队/); assert.match(matching, /单人默认只进标准规则的对局/);
  assert.doesNotMatch(matching, /revivalVote|开启复活并确认|赞成开启/);
  assert.match(source('../../public/js/screens/room.js'), /<b>\$\{t\('实验性选项'\)\}<\/b>/); assert.match(experimental, /revivalEnabled/); assert.match(experimental, /disableSharedPool/);
  assert.match(revival, /me\.lp >= 11/); assert.match(revival, /至少 11 生命的存活队友可支付 10 点救援/);
});
