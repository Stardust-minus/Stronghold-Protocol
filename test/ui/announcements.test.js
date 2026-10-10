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
  assert.notEqual(entries[0], first); assert.notEqual(entries[0].paragraphs, first.paragraphs);
  entries[0].paragraphs.push('只改变返回值'); assert.equal(first.paragraphs.length, 2);
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

test('today\'s update rewrites the content and apology while preserving cumulative history and introduction', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].title, '10 月 11 日更新与维护致歉');
  assert.equal(entries[0].date, '2026-10-11');
  assert.equal(entries[1].title, '0.2.2／0.2.3 累计更新');
  assert.equal(entries[1].date, '2026-10-10');
  assert.equal(entries[2].title, '欢迎游玩卫戍协议！卫来！');
  const today = entries[0].paragraphs.join('\n');
  for (const feature of ['非常抱歉', '大厅延迟', '加载缓慢', '连接中断', '支持折叠', '触控和遮挡', '收进「更多」', '统一放在「设置」', '两项偏好分别保存', '等待人数', '包含自己或本队', '全员确认', '减少动画', '二十名真人', '完整干员配置', '开战属性与实时生命值', '压缩处理', '每秒 10 次同步', '已结束战场的重复快照', '单个公开素材加载失败后的备用来源重试', '/healthz', '接入迁移', '本次更新中断了旧房间与对局']) assert.ok(today.includes(feature), feature);
  assert.doesNotMatch(today, /保证不卡顿|带宽无限|固定比例下降|Boss.*已修复|会话重置.*已修复/);
  assert.match(today, /服务器扩容与接入迁移已完成，正式服务现已恢复/);
  assert.doesNotMatch(today, /正在进行服务器扩容|具体开放时间|开放后请|不[^。；]{0,100}，也不/);
  assert.notEqual(today, entries[1].paragraphs.join('\n'));
  const text = entries[1].paragraphs.join('\n');
  for (const feature of ['0.2.3 · 新内容与便利功能', '克莱门莎', '黍、乌尔比安的新模组', '四档文字大小', '逐干员配音偏好', '安装到桌面', '恢复已关闭窗口的对局', '不会顶掉仍在使用的窗口', '全体真人一致同意后重刷', '每四人共享一卡池', '扩容模式策略可重复', '统一六项、可重复选择', '每人仍只选一次', '固定 300 游戏秒', '两场各 150 秒', '单场为 300 秒', '提前结束不延长下一场', '4／8／12／16／20', '整队匹配相同人数模式', '全员确认后直接开局', '匹配前仍需队友准备', '普通大厅匹配默认四人', '原同盟密钥或旧邀请链接观战', '仅观看当前对局', '271 套时装战斗模型', '部分动态立绘仍待补', '界面语言和中／日／英配音', '一份完整预设', '兼容旧的单项配置', '回退中文', '实验性多人默认关闭', '接力联防', '禁用鸭爵，默认不禁用', '队友机变显示', '准备区模型首帧', '战斗数值展示']) assert.ok(text.includes(feature), feature);
  assert.doesNotMatch(text, /8／10／16／20|开启后禁用匹配|两轮共用|提前结束保留余额/);
  assert.match(text, /不改变技能、模组或战斗属性/);
  assert.match(text, /中断旧房间与对局/);
  assert.match(entries[2].paragraphs.join('\n'), /纯公益.*非官方/);
  assert.match(entries[2].paragraphs.join('\n'), /github\.com\/sganggs\/Stronghold-Protocol/);
  for (const feature of ['0.2.2 与 0.2.3', '潜能 1–6', '默认潜能 6、精英阶段2-60级', '行内快捷选择技能、模组', '本机统计数据', '历史结算回看', '可导入导出', '记录只在本机浏览器保存', '点选干员语音', '场地装置', '当前攻击范围', 'AI 队友最后选择', '双击队友头像', '领袖场传送门', '位移失衡', '杜宾教鞭三选一', '每人 50 秒', '至少 11 生命时支付 10 点救援', '每局最多获救一次', '不刷新其干员、装备或经济', '优化静态资源 CDN 加载', '脚本、字体和游戏素材', '实际加载仍受网络与源站状态影响']) assert.ok(text.includes(feature), feature);
  assert.doesNotMatch(text, /自动切源|自动选择最优|保证不卡顿|完全消除卡顿/);
  assert.ok(entries.flatMap(entry => entry.paragraphs).join('\n').length < 2500, 'today\'s update, cumulative history and introduction stay bounded');
});

test('announcements omit contacts and infrastructure; the lobby owns the copyable group number', () => {
  const entries = parseAnnouncements(JSON.parse(source('../../data/announcements.json')));
  const text = entries.flatMap(entry => entry.paragraphs).join('\n');
  assert.doesNotMatch(text, /QQ|群号|815818430|2225664821|coordinator|ingress|Worker|WireGuard|ModelScope|OpenI|\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  assert.match(source('../../public/js/ui/lobbyFeedback.js'), /FEEDBACK_GROUP = '815818430'/);
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
  assert.match(matching, /未完成确认者不自动回队/); assert.match(matching, /单人匹配跟随所加入房间/);
  assert.doesNotMatch(matching, /revivalVote|开启复活并确认|赞成开启/);
  assert.match(experimental, /title=\$\{t\('实验性选项'\)\}/); assert.match(experimental, /revivalEnabled/); assert.match(experimental, /disableSharedPool/);
  assert.match(revival, /me\.lp >= 11/); assert.match(revival, /至少 11 生命，可支付 10 点救援/);
});
