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
  assert.equal(entries.length, 5);
  // 2026-11-20 the owner asked for this release's notice to go into the repo: the experimental ELO, the match receipts, AI teammates
  // rescuing and 卡池静态初始化 on top. To fit it the three older fork notices were condensed (the owner: 「压缩，不能删除，另外10-06的不能动」)
  assert.equal(entries[0].title, '实验性 ELO 与卡池静态初始化、对局凭证、AI 队友会救人');
  assert.equal(entries[0].date, '2026-11-20');
  const notice1120 = entries[0].paragraphs.join('\n');
  for (const phrase of ['【ELO】', '「ELO」', '默认关闭', '此功能仅为娱乐', '版本、模式、难度', '最近 30 局', '50%', '只能看到自己的', '不能组队匹配',
    '【对局凭证】', '已核验', '5 局已核验', '本机记录只会更压', 'cookie', '不收集设备信息', '服务器也不保存你的战绩', '请勿把文件给别人',
    '名片奖杯', '按凭证计数', '第二期照旧', '【队友复活】', '队友复活', '生命至少 11', '付 10 生命', '生命最多的出', 'AI 不救 AI', '谁救了谁',
    '卡池静态初始化', '按阶级平分', '含 AI 队友', '「余 n」', '「我的实验性」', '每局单独生成的密钥'])
    assert.ok(notice1120.includes(phrase), phrase);
  assert.doesNotMatch(notice1120, /签名|nginx|WebSocket|QQ|Worker|ModelScope|OpenI|Redis|Valkey|HMAC|coordinator|ingress|\/feedback|#1[0-9]|正在修|正在处理/i);
  // 2026-11-16 the owner's 「名片为啥没办法选塔露拉」 and 「对于动态立绘能不能带上背景」: their own notice on top; rel43 never went out,
  // so on 2026-11-17 (the owner: 「全量动态背景吧」) the same notice also carries the scenes played live
  assert.equal(entries[1].title, '名片可选精二立绘，动态立绘实时播放原作场景');
  assert.equal(entries[1].date, '2026-11-17');
  const rel43 = entries[1].paragraphs.join('\n');
  for (const phrase of ['【名片】', '默认立绘和精二立绘', '塔露拉', '在名片上播放', '按干员分组', '阿米娅', '报童', '见习联结者', '播种者',
    '于万千宇宙之中', '触及星辰', '只能用作名片', '【动态立绘】', '原作的完整场景', '「查看立绘」', '座位卡', '粒子', '实时播放',
    '97 套', '时装 71 套', '精二 26 套', '遥「常世之幻」', '重岳精二', '无缝换上', '互动动作里的特效暂不包括', 'W「恍惚」', '夕「染尘烟」', '官方的取景位置',
    '不再拉伸错位', '仍只显示人物'])
    assert.ok(rel43.includes(phrase), phrase);
  assert.doesNotMatch(rel43, /ModelScope|OpenI|PRTS|DXBC|WebP|烘焙|签名|nginx|Worker|WebSocket|\/feedback|#1[0-9]|ac_s_closur|正在修|正在处理|QQ/i);
  // 2026-11-16 the owner's UI overhaul (「UI必须大修」) gets its own notice; the 0.4.0 notice below keeps its text,
  // less the interface author's QQ (the owner: 「删除前端反馈QQ」)
  assert.equal(entries[2].title, '界面大修：对局界面、选择策略、成就、设置与匹配');
  assert.equal(entries[2].date, '2026-11-16');
  const rel42 = entries[2].paragraphs.join('\n');
  for (const phrase of ['黑色缺口', '锡拉库扎城区', '「卫戍协议终端」', '🔍', '「已就绪」', '「冻结」「刷新」', '可露希尔主题的商店卡', '分为两行',
    '金色标识', '彩色', '红色角标', '拼音首字母', '「Doctor…」', '华法琳', '娜仁图雅', '按期显示', '「绝境突破」', '「已获赞」', '150 / 200 / 300',
    '18 个', '塔露拉', '27 名干员', '「查看立绘」', '双色着色', '8 页', '「素材下载」', 'github.com/Stardust-minus/Stronghold-Protocol',
    '「已开启 n 项」', '「标准规则」', '「我的实验性」', '「任意实验性」', '保留排队位置', '30 秒', '繁体中文', '运营商和省份'])
    assert.ok(rel42.includes(phrase), phrase);
  assert.doesNotMatch(rel42, /ModelScope|OpenI|签名|nginx|Worker|WebSocket|lanes|\/feedback|#1[0-9]|ac_s_closur|正在修|正在处理|QQ|Grafana|SP_ISP|coordinator/i);
  assert.equal(entries[3].title, '版本更新：同步原作 0.4.0，按版本匹配，连接更稳定');
  assert.equal(entries[3].date, '2026-11-16');
  const rel40 = entries[3].paragraphs.join('\n');
  for (const phrase of ['私人运行', '待休赛期再对外开放', 'github.com/sganggs/Stronghold-Protocol/releases/tag/v0.4.0', '只列本服自己的调整',
    '「规程·序列Ⅰ」', '第二期下半', '「选择自编」', '「自选四选二」', '按版本分池', '「多人匹配」', '「组队匹配」', '3 条连接', '1.5 秒',
    '「大厅背景」', '「规程」主题', '红色的无法出现干员数', '「设置 → 界面主题」', '“全能的”可露希尔', '「更新说明」弹窗不加',
    '39 套时装', '寰宇独奏', '54 名干员', '15 套动态立绘', '漫步于黄金之梦', 'Touch', '歌利亚', '「反馈板」', '雨千代chiyo', 'xinhai-ai',
    // 2026-11-16 the owner: the fixes that followed go into this notice (「完成之后最新公告合入这些修改」)
    '「载入中…」', '「加载中」', '18 套动态立绘',
    // 2026-11-16 the owner: 「开场动画去掉点击进入，直接自动播放进入就行了，然后看看auth页完成之后能不能做一些转场切换」
    '自动播放', '过渡到游戏的载入画面', '「连接终端」', '无声播放', '大厅音乐从头开始', '「查看立绘」', '泥岩二技能', '不计入挂机', '选择自编也算作操作', '「收起」', '「余 n」', '「天马之耀」', '【验算】', '以服务器结果为准', '帧率很低的问题已修正'])
    assert.ok(rel40.includes(phrase), phrase);
  assert.doesNotMatch(rel40, /ModelScope|OpenI|签名|nginx|Worker|WebSocket|lanes|\/feedback|#1[0-9]|ac_s_closur|正在修|正在处理/i);
  // the 10-06 introduction stays untouched (the owner: 「10-06的不能动」)
  assert.equal(entries[4].title, '欢迎游玩卫戍协议！卫来！');
  assert.equal(entries[4].date, '2026-10-06');
  assert.match(entries[4].paragraphs.join('\n'), /纯公益.*非官方/);
  assert.match(entries[4].paragraphs.join('\n'), /github\.com\/sganggs\/Stronghold-Protocol/);
  assert.match(entries[4].paragraphs.join('\n'), /界面致谢：.*Bilibili@雨千代chiyo/);
  assert.match(entries[4].paragraphs.join('\n'), /第一次来的博士：.*「玩法说明」/);
  // condensed on 2026-10-17 (the 0.3.0 notice alone had grown past 3000): the board scrolls, but the notices stay bounded;
  // on 2026-11-20 the three older fork notices were condensed again to fit the new one
  assert.ok(entries.flatMap(entry => entry.paragraphs).join('\n').length < 4000, 'the notices stay readable');
});

test('announcements omit contacts and infrastructure', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  const text = entries.flatMap(entry => entry.paragraphs).join('\n');
  // 2026-11-16 the owner: 「删除前端反馈QQ」 — the interface author's QQ (the 2026-10-14 request) is gone too; the credit stays
  assert.deepEqual([...text.matchAll(/QQ\s*(\d+)/g)].map(m => m[1]), []);
  assert.match(text, /新界面由 Bilibili@雨千代chiyo 设计制作。/);
  assert.doesNotMatch(text, /374360968|QQ|群号|243859707|815818430|2225664821|coordinator|ingress|Worker|WireGuard|ModelScope|OpenI|\b\d{1,3}(?:\.\d{1,3}){3}\b/);
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
  assert.match(matching, /超时未确认的博士退出匹配；有人退出时，其余博士保留排队位置继续等待/); assert.match(matching, /单人默认只进标准规则的对局/);
  assert.doesNotMatch(matching, /revivalVote|开启复活并确认|赞成开启/);
  // the room's footer names 实验性功能 and how many are on, the list by group in its 浮窗 (the owner, 2026-11-16)
  assert.match(source('../../public/js/screens/room.js'), /<\$\{ExperimentalBadge\} value=\$\{room\.experimental\}/);
  assert.match(experimental, /const name = label \|\| t\('实验性功能'\)/); assert.match(experimental, /revivalEnabled/); assert.match(experimental, /disableSharedPool/);
  assert.match(revival, /me\.lp >= 11/); assert.match(revival, /至少 11 生命的存活队友可支付 10 点救援/);
});
