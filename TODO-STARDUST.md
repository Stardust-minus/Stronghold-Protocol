# Stardust 当前开发 TODO

更新时间：2026-10-05。线上已经是 `d71fb2d` / `v012-simple-20261004`，三服务单 project、无 CPU/内存 cap；真实发布记录见 `deploy/stardust/releases/v012-simple-20261004.json`。

## 新批次：官方 0.1.3 / 救援诊断 / 默认无片头

- [x] 核实官方 `v0.1.3` 固定提交 `a0a5419eb875fb24de62e4dfb32b78cfcb3090be`，在独立同步分支完成冲突处理，保留本站功能与安全边界。
- [x] 上游观战/kick 与 party 原子转移、观战不投票不占队列席、Worker 真观战流/重连兼容回归。
- [x] 实际六 Worker、四真人 WS 和浏览器验证 LP11救援；具体用户报告局原因未复现，不能宣称已修好。增加权威不可用原因与明确文案，不放宽规则或资源清理。
- [x] auth 片头/进入转场默认关闭，显式 per-browser opt-in；默认不下载场景库，口令/CSRF/昵称/profile验证保留，真实桌面/手机验收通过。
- [x] 最终 Node24 Linux canonical：3925 tests，3909 pass、16 skip、0 fail/cancel；实际整队、观战/kick、准备余款确认、Worker重连浏览器通过。
- [x] D71正式CPU profile保存：混合场景非idle bot rehearsal76.54%、经济/布局17.60%；正式战斗仍6worker，不宣称新offload已做。
- [ ] 本批次正式提交/推送/配套发布按用户指令办理；本地验证不代表已上线，当前线上仍D71。
- [ ] 后续优先布局重复分配/缓存、纯候选trial有界低优先级offload（主线程仍管RNG/UID/cardpool/经济/提交），在0.1.3基线复验，不新增gateway或服务。
- [ ] 不整树移植第三方fork；官方013已有ART清单8秒保护，核心数据超时、queue预热、慢载入诊断和可靠取消仍可后续补充。

以下保留 **D71发布前的历史验收清单**，未勾选的发布/元数据状态不覆盖上述实际发布记录；不要重复旧activation或恢复caps。

## 已完成的本地修正

- [x] 删除服务端 rolling/control/gateway、专用配置和测试，不保留休眠多版本运行时。
- [x] 删除前端 release router、drain 状态、版本切换提示和跨版本人数轮询；主助手亲自修改，入口 `/`、WS `/ws`，保留正常重连、在线人数和上游 `/client-build` 陈旧页面检查。
- [x] 单 project `ark-proto`、固定三个服务：game3120/auth3141/assets3130；三者无 Docker CPU/内存硬限额，保留 PIDs、只读、安全和日志限制。游戏仍是 server/off、6 Worker、maxRooms4096。
- [x] 正式 Nginx 模板基于已知真实 direct3120 配置收敛：门禁、PRTS、严格 Origin、可信 IP 覆写、WS/认证限流、静态 CORS、OpenI3130、宁夏 fonts/vendor 保留。
- [x] 旧 `/_release/v012-alliance-20261004/` 仅作精确临时别名；HTML 回 root，只透传合法 room 和 `_prts=1`。未知 prefix、health/control/material/private server 路径拒绝。不再生成新的游戏版本 URL。
- [x] root hooks adapter 直接游戏，防止旧静态 hooks 的 prefix import 形成第二份 Preact；旧 immutable 文件不改写。
- [x] 静态准备器去游戏 release 分支，保留普通 immutable `/releases/`、root hooks、相对字体、revision/hash/lock、精确库存、媒体/MIME/Range/CORS 及 fail-closed 校验。
- [x] OpenI resolver 删除仅为网关验身的 metadata endpoint，保留签名验证、缓存隔离、预热/续签和同版本 fallback，不需要账户 Token。

## 复活规则

- [x] 按真人严格多数开启：2 人需 2 票、3 人需 2 票、4 人需 3 票；单真人不能启用，AI 不计入分母或投票。
- [x] 好友房按当前真人数显示门槛；开局锁定，成员变化重新计算，不继承离开者的票。
- [x] 复活抵消该次死亡：pendingDeath 保留原干员、棋盘、装备、经济、效果与资源占用，不初始化或重新抽取；窗口结束才清理未获救者一次。
- [x] 本轮未漏怪且实际参加联防的存活真人帮手须 LP >=11，支付10后至少剩1；被救者恢复1，每人每局仅一次。终局、Boss共享LP、已完成淘汰和主动退出不能误救。
- [x] LP9/10拒绝、资格/重复/并发/超时、状态指纹及卡池单次归还测试通过；主助手保留等待救援、代价和不可用原因展示。

## 单排与好友整队公开匹配

- [x] 保留单人和好友合作；公开匹配同难度4真人、无AI、30秒确认、10分钟TTL。
- [x] 单排 `queue.join {difficulty}`；等待中的好友coop房主发起 `queue.join {difficulty,party:true}`，1–4名在线兼容真人整体排队，无机器人、不拆散队伍。
- [x] 房主发起整队排队，**每位玩家分别确认自己的复活票**：`queue.accept {ticketId,offerId,revivalVote:boolean}`。前端一次点击完成投票和入场确认，不由队长替其他人确认。
- [x] 四人全确认后原子启动普通 Match，直接进入游戏；不再要求等待房内 room.ready 或房主 room.start。游戏本身的战前说明、盟约选择、休整阶段仍保留。
- [x] 队员取消/断线取消整队并保留原好友房；换socket同身份保持确认。排队期间锁成员、难度、准备、原房投票、开局和机器人操作，退出先取消队伍，loadout可同步。
- [x] FIFO按不可拆队伍单位优先最早可组成四人的组合，不能补齐的队伍不阻塞后续全部组合。组合搜索有界，不扫描任意规模子集。
- [x] 成功才移除旧party房并转移成员，不能发送迟到 room.closed 清掉新游戏；按所有参与网络核算配额，并扣除真实被替换旧房占用。
- [x] 构造/启动/容量/codegen失败不发布半创建状态，保留原房、票、loadout、健康ticket的FIFO/TTL和其他队列；失败留queued，避免无限立即reoffer。
- [x] 能力版本 alliance-2，拒绝不兼容的旧公开匹配客户端。全部16种投票组合、140 cohort七种竞态fuzz、配额转移和默认Match真实四WS测试通过。
- [x] 主助手四真实浏览器验证：单排自动开局/重连/draft/PREP、普通好友手动流程、2/3人共识、队员取消、2+2、3+1和4人整队；无控制台或资源错误。桌面与844×390截图已读取检查。

## 开源昵称检测与门禁

- [x] 真正复用 mint-filter4.0.3引擎，匹配算法字节溯源验证；仅做规范化与英文边界适配，不自写核心检测。
- [x] 固定 fwwdn综合分类、houbb政治tag0及LDNOOBW语料，共3822条源记录（未扣重复/非政治误伤排除）；政治分类2355条逐条命中，不保留政治豁免。
- [x] NFKC、大小写、零宽/不可见、常见分隔符命中；输入/词库有界，正常干员名与英文词界防误杀。词库不保证穷尽语义或全部变体。
- [x] 游戏hello/rename/resume与门禁login/profile共用同一服务端策略，不修改随机playerId，不清除合法身份/旧房，不回显拒绝词。
- [x] 三份Dockerfile显式包含全部9个canonical代码/数据/许可证文件，MIT/Apache-2.0/CC-BY-4.0来源哈希保留；真实认证镜像验证通过。
- [x] root-only safeNext/entry前端；口令、CSRF、签名Cookie、限流、PRTS及重入动画保留。真实浏览器验证政治词拒绝、修正后恢复同身份/好友房，以及已登录profile和自动重入错误反馈。

## 验收与待发布

- [x] Node24昵称/认证/身份专项104/104；匹配/大厅/loadout/复活联合183/183；前端根路径专项255tests（252pass/3skip）；独立复活+昵称114/114。
- [x] 真实Nginx1.28.3 TLS + Node24 game/auth/resolver通过门禁、根路径、精确旧prefix、可信头、严格Origin、OpenI两模式、公开CORS、凭据剥离、fallback和auth故障fail-closed。stock Nginx缺Lua，实际OpenResty人数聚合正文明确skip；其门禁/内部健康404已验证。
- [x] 使用历史workers immutable材料的临时副本完成5529文件、536stem、3752后缀alias真实静态Nginx回归14/14；原材料不变。这不是新版本静态发布验收。
- [x] 完整Linux Node24 canonical：3778tests/304suites，3761pass、17skip、0fail、0cancel；290个文件，显式排除Windows专属文件及忽略的构建导出。首轮3项失败证据保留：2处旧相对CSS断言改为root、客户端战斗专用fixture显式clientCombat:true隔离生产server环境，全部业务断言保留；重跑32项及全套均通过。
- [x] 新本地开发游戏镜像无源码挂载、6Worker真实四浏览器12步全部通过，errors=[]；auth/assets本地镜像构建与引擎/接口打包检查通过。镜像明确标为working-tree，不冒充已提交revision或生产镜像。
- [ ] 经用户要求后提交/合并/推送，固定正式commit，并按双机SOP准备新游戏、auth、resolver与匹配静态manifest，不能直接发布工作树快照。
- [ ] 下次经授权统一重建三个服务，统一project labels与Docker metadata；本轮实际cgroup热解除已生效，但旧HostConfig仍有历史CPU/mem字段，直接restart旧容器可能重新施加旧cap。
- [ ] 发布前读实时人数/对局和配置，说明重建会清除内存局，按当前授权窗口操作；游戏、素材、字体、vendor配套切换及成对回滚。正常Nginx reload不等于被取消的游戏平滑更新。

## 后续独立范围与持续边界

- [ ] 进一步主线程profiling/实际offload。本轮没有新增机器人预览等offload；已上线pacing时间债务修复与offload是不同事项。
- [ ] 宁夏证书自动续期另行安排；现手动证书/已发布静态资源不改。ModelScope仍只作备选，不擅自迁移。
- 不在生产压测、不清其他玩家房间、不触碰其他网站/数据库/证书；不提交密码、Token、Cookie、签名URL、密钥、游戏素材、生成vendor、日志或用户截图。
- 最新交接见 `.claude/simple-social-handoff.md`；`.claude/emergency-simple-handoff.md`记录前一阶段线上恢复。更早rolling计划仅历史，不重新执行旧Compose/activation脚本。
