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

test('the notices: the 0.3.1 sync (2026-10-18) over this update (skin effects, card looks, kick and reroll votes, the layer forecast, the fixes, the feedback board and status page) over a 0.3.0 recap (official effects, voices, 8–20 seats choosing at once, restart recovery, credits to the original and to xinhai-ai, the access rule); the introduction is retained with the credit and a first-visit guide', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  assert.equal(entries.length, 8);
  // 2026-11-03 (rel28): the four planned feedback items — the briefing's pinned 自选上场 (#127), 塔露拉's S3 cast (#124), the
  // collab fallback (#128), the bar's chosen / total (#126); the older notices condensed to stay in the bound (the owner, 11-03:
  // 「压缩，不能删除，另外10-06的不能动」)
  assert.equal(entries[0].title, '版本更新：开局自选更醒目，塔露拉三技能调整，联动干员自动换回');
  assert.equal(entries[0].date, '2026-11-03');
  const rel28 = entries[0].paragraphs.join('\n');
  for (const phrase of ['「自选上场」', '「准备就绪」上方', '2 名', '塔露拉', '荒芜拉普兰德', '可选目标', '联动干员', '原来的自选干员', '「已选/总数」']) assert.ok(rel28.includes(phrase), phrase);
  assert.doesNotMatch(rel28, /ModelScope|OpenI|签名|nginx|Worker|GDGLOW|\/feedback|#12/i);
  // 2026-11-03 (rel27): live dynamic art in more places (and the seat framing), the official dynamic avatars, the
  // per-round enemy HP multiplier (#118), the 甄选干员 count, the damage board's 自选 names, 塔露拉's talent note
  assert.equal(entries[1].title, '版本更新：动态立绘全面播放，官方动态头像，敌人生命倍率按回合设置');
  assert.equal(entries[1].date, '2026-11-03');
  const rel27 = entries[1].paragraphs.join('\n');
  for (const phrase of ['干员调配', '自选立绘框', '名片', '玩家头像', '「调整立绘」', '夕「青玉砚」', '「组织」', '「凝视映像」', '粒子特效',
    '「按回合设置敌人生命倍率」', '2.5 倍', '「甄选干员」', '4 名候选', '伤害统计', '塔露拉']) assert.ok(rel27.includes(phrase), phrase);
  assert.doesNotMatch(rel27, /ModelScope|OpenI|签名|nginx|Worker|WebGL|\/feedback|\/assets/i);
  // 2026-11-03 (rel26): older versions get the later 6★ 自选, 4 自选 candidates (pick 2), client-side prediction, the
  // mechanic fixes from the feedback board, the HUD under the feet, the new skins and dynamic art, the view fixes
  assert.equal(entries[2].title, '版本更新：历史版本补齐新干员，自选四选二，操作即时响应');
  assert.equal(entries[2].date, '2026-11-03');
  const rel26 = entries[2].paragraphs.join('\n');
  for (const phrase of ['第一期、第二期', '麒麟R夜刀', 'EXE-Y', '从下次维护起', '「未知」', '4 名候选', '「自选上场」', '任选 2 名', '标红', '标黄',
    '立即显示结果', '华法琳', '魔王三技能', '雪猎', '荒芜拉普兰德', '再部署时间', '模型脚下', '「领袖战输出」', '凛御银灰「雪覆伦城」',
    '薇薇安娜「还愿礼」', '号角「锋光初现」', '凯瑟琳「暖冬教室」', '5 款联动皮肤', '60 套动态立绘', '红色水滴', '2 倍速']) assert.ok(rel26.includes(phrase), phrase);
  assert.doesNotMatch(rel26, /ModelScope|OpenI|签名|nginx|Worker|\/feedback|\/assets\/collab|预测/i);
  // 2026-11-02 (rel25): the three new 自选 6★, the collab switch and its copyright warning, the reroll and the 淘汰 result
  assert.equal(entries[3].title, '版本更新：塔露拉、冻河、国度加入自选，实验性联动干员');
  assert.equal(entries[3].date, '2026-11-02');
  const rel25 = entries[3].paragraphs.join('\n');
  for (const phrase of ['塔露拉（协防、奥术、不屈）', '冻河（协防、灵巧、迅捷）', '国度（协防、独行）', '奥术与不屈各 +1 层', '「联动干员」', '自建同盟的房主',
    '灰烬、艾拉、麒麟R夜刀、焰狐龙梓兰、玛露西尔、丰川祥子、结城理', '等待 5 秒确认', '版权风险由启用和使用联动干员的玩家自行承担', '只有开启的房间才会加载',
    '不能组队匹配', '「重刷本局」', '「前往结算」', '克莱门莎']) assert.ok(rel25.includes(phrase), phrase);
  assert.doesNotMatch(rel25, /ModelScope|OpenI|签名|nginx|Worker|\/feedback|\/assets\/collab/i);
  // 2026-11-02 (rel23/rel24): 2 倍速、手动卡池编组、公开同盟
  assert.equal(entries[4].title, '版本更新：战斗 2 倍速、手动卡池编组、公开同盟');
  assert.equal(entries[4].date, '2026-11-02');
  const rel23 = entries[4].paragraphs.join('\n');
  for (const phrase of ['「2 倍速」', '3/4 在线博士', '下一场战斗开始', '本地演算', '「禁用层数上限」', '「禁用单次伤害上限」', '「敌人生命倍率」', '「敌人攻击倍率」',
    '3 人一组', '总时间预算', '「公开同盟」', '「公开到同盟列表」', '多个难度', '「反馈板」', '「手动指定卡池编组」', '「多人同盟」', '「实验性规则」', '「卡池」']) assert.ok(rel23.includes(phrase), phrase);
  assert.doesNotMatch(rel23, /ModelScope|OpenI|签名|nginx|Worker|\/feedback/i);
  // 2026-10-30: the 0.3.3 notice goes on top (rel22)
  assert.equal(entries[5].title, '版本更新：同步原作 0.3.3，历史版本可玩，处理反馈板计划内容');
  assert.equal(entries[5].date, '2026-10-30');
  const sync33 = entries[5].paragraphs.join('\n');
  for (const phrase of ['原作 0.3.2 与 0.3.3', '第一期上半', '26 款皮肤', '不会恢复', '「重刷本局」不再限制次数', '「部署时按格子吸附」', '198 个官方头像',
    'github.com/sganggs/Stronghold-Protocol']) assert.ok(sync33.includes(phrase), phrase);
  assert.doesNotMatch(sync33, /ModelScope|OpenI|签名|nginx|\/feedback/i);
  // 2026-10-18: the 0.3.0 (10-16), skin-effect (10-17) and 0.3.1 (10-18) notices folded into one recap (rel25, the bound)
  assert.equal(entries[6].title, '10 月中旬更新回顾：原作 0.3.0 与 0.3.1、官方特效与皮肤特效');
  assert.equal(entries[6].date, '2026-10-18');
  const recap = entries[6].paragraphs.join('\n');
  for (const phrase of ['原作 0.3.0 与 0.3.1', '请刷新页面重新进入', '「设置 → 官方特效」', '专属特效', '「协议已失效」', '全员同时选择', '「正在恢复对局…」', '「投票移出」',
    '「本土语言」', '「显示其他玩家的皮肤」', '「反馈板」', '「服务器状态」', 'github.com/sganggs/Stronghold-Protocol', 'github.com/xinhai-ai/Stronghold-Protocol',
    '@Misyra', '插件功能和测试房间本服务器暂不开放', 'Bilibili@雨千代chiyo', '只向中国大陆网络开放']) assert.ok(recap.includes(phrase), phrase);
  assert.doesNotMatch(recap, /ModelScope|OpenI|签名|nginx|\/feedback|\/monitor|Grafana/i);
  assert.equal(entries[7].title, '欢迎游玩卫戍协议！卫来！');
  assert.equal(entries[7].date, '2026-10-06');
  assert.match(entries[7].paragraphs.join('\n'), /纯公益.*非官方/);
  assert.match(entries[7].paragraphs.join('\n'), /github\.com\/sganggs\/Stronghold-Protocol/);
  assert.match(entries[7].paragraphs.join('\n'), /界面致谢：.*Bilibili@雨千代chiyo/);
  assert.match(entries[7].paragraphs.join('\n'), /第一次来的博士：.*「玩法说明」/);
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
  assert.match(revival, /me\.lp >= 11/); assert.match(revival, /至少 11 生命，可支付 10 点救援/);
});
