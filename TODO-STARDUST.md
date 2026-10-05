# Stardust 当前开发 TODO

更新时间：2026-10-05。线上已于11:34:34 +08切到 `186cda7` / `v013-ui-20261005`，三服务单project、6combat+1trial、无CPU/内存cap；发布记录见 `deploy/stardust/releases/v013-ui-20261005.json`。仅关闭片头、保留其他动画，输出面板避让表情并加头像的修正均已上线。实际生产双浏览器、真实战斗/表情/头像/资源分流验证通过，1408响应、0错误；后续仅记录提交不再重启。

## 最新本地批次：热键 / Boss 缩放 / 可靠性 / health（未发布）

开发分支 `feat/reliability-health-20261005`，基线 `ff3cf3e`；详见 `.claude/reliability-health-progress.md` 与 `.claude/unite-board-progress.md`。用户现已要求先提交推送，凌晨再重启更新；尚未部署，以上生产记录不变，不能现在重启。不提前合入官方未合并 PR（包括 #109/#115/#126），只按用户批准做独立小改动。

- [x] Q 撤退 / X 出售选中干员，共用原动作及权限；输入、IME、弹窗/托管、拖拽/朝向和忙碌状态保护，主助手亲写并实际按键验收。
- [x] 全局及四个MULTI模式启用已有 Boss 存活席位 n/4 缩放；各Boss开战取人数，AI计入、观战不计，当前血池不随战中减员变化；单人0.25及训练false保持，生成器/文档/真实Worker回归同步。
- [x] 取消意图跨半开连接恢复：原会话/票据/代次隔离、fresh hello校准、一次主动重连、两次恢复请求和30秒总预算，不假装取消成功或误取消新票。
- [x] 核心JSON 30秒请求+读体期限、Abort和有界重试；保留art8秒降级恢复。慢载入显示文件并提供重试/刷新，核心数据失败不会遮住结算/已结束返回入口；触屏文字与点击目标实际看图。
- [x] 用户追加：offer提前解散或到期后，未确认者默认退出，不再自动回队；partial party整队退出但保留原好友房。全确认队伍保留既有FIFO/TTL和分配失败恢复；新中文原因`unconfirmed`。
- [x] health每10秒缓存全进程CPU/RSS、主线程ELU/loop/heap；清晰标注口径，保留原HTTP健康判定、6+1计数和公网404/internal边界，client-build仍只build，不新增服务或调试端口。
- [x] Node24完整canonical：4145tests / 4129pass / 16skip / 0fail；后续仅触屏字号调整，相关UI/CSS回归与最终8步真实浏览器重跑通过、errors=[]。本地TLS gate/health/WS/OpenI/CORS 2pass/1skip，Stock Nginx不支持Lua的presence聚合body子测试明确跳过。
- [x] 后续联防显示修正：按实际联防场的两个helper分区展示姓名/干员/小计，双方合计仍为本轮normal+unite，不混入漏怪方或其他场。普通视角、Boss限制和PREP冻结不变；桌面与触屏原生滑动、头像/Tooltip归属/独立小计、表情互斥经main实际看图。Node24专项75/75，最新全量4151tests / 4135pass / 16skip / 0fail；最初与Chrome并发时有一条既有trial时序断言失败，未改断言，独立20/20和最终单独全量均通过，证据见 `.claude/unite-board-progress.md`。
- [ ] 胜利返回后重连会被旧结算回放拉回，已用线上186镜像本地复现；正常返回/真正离房可用。本次仅按用户要求修联防，该重连边界未修，见 `.claude/victory-unite-investigation.md`。
- [x] 用户已明确要求本批测试通过后先提交并推送；不合入官方未合并 PR。
- [ ] 用户要求晚点凌晨重启更新（2026-10-06 +08，具体时刻未约定，未设置自动任务）。当前不重启；窗口前按SOP从固定新提交准备离线镜像和配套静态、校验及本地验收，再协调切换。旧activation脚本和旧发布许可不复用。

## 历史批次：官方 0.1.3 / 救援诊断 / 默认无片头

- [x] 核实官方 `v0.1.3` 固定提交 `a0a5419eb875fb24de62e4dfb32b78cfcb3090be`，在独立同步分支完成冲突处理，保留本站功能与安全边界。
- [x] 上游观战/kick 与 party 原子转移、观战不投票不占队列席、Worker 真观战流/重连兼容回归。
- [x] 实际六 Worker、四真人 WS 和浏览器验证 LP11救援；具体用户报告局原因未复现，不能宣称已修好。增加权威不可用原因与明确文案，不放宽规则或资源清理。
- [x] 0.1.3初版曾误把片头/进入转场一起默认关闭。按用户后续更正，当前修正版仅片头默认关，保留组装、WebGL界面、成功凭证及进入动画；旧全局0不再禁用其他动画，真实口令/CSRF/profile验证仍保持。spatial-07脚本URL防旧缓存，修正版部署状态见本文件开头。
- [x] 最终 Node24 Linux canonical：3925 tests，3909 pass、16 skip、0 fail/cancel；实际整队、观战/kick、准备余款确认、Worker重连浏览器通过。
- [x] D71正式CPU profile保存：混合场景非idle bot rehearsal76.54%、经济/布局17.60%；正式战斗在6 Worker。它是选优化目标的依据，不是下述v0.1.3收益基线。
- [x] 上述0.1.3/auth/救援诊断在 `902a37d` 合并，随 `6a4d900` 已推送并部署。用户具体报告局的救援原因未复现，不能将诊断改进说成已修好该局。
- [x] 不整树移植第三方fork；官方013的ART清单8秒保护继续保留。核心数据超时、慢载入诊断和可靠取消已在上述2026-10-05本地批次实现；queue预热仍未纳入，不把本地实现误记为线上已发布。

## 最新本地批次：实际主线程减负 / 局内输出榜

当前分支 `perf/main-thread-relief-013`，base `902a37d`。详细证据见 `.claude/perf-relief-progress.md` 与 `.claude/damage-board-progress.md`，不是旧待实施计划。

- [x] 布局评分复用 prefix 和 dense scratch，保持候选/浮点顺序、RNG/UID/最终布局；165项回归通过，两组同v0.1.3工作量主线程CPU下降2.4–2.9%。
- [x] 纯候选trial实际接入现有六Worker的有界低优先RPC；正式combat/cleanup优先，32tick/约4ms切片，原64tick剪枝不变；生命周期/输入指纹取消、迟到结果拒绝与完整候选inline故障fallback完成。真实Match集成166项通过。
- [x] 两组mixed同工作量对照：96 jobs / 288候选 / 883456ticks / 336购买；主线程CPU下降64–69%，但进程总CPU增加56–72%，准备总时长增加约2–6%。响应尾延迟与时间债务改善；不是总CPU节省或AI提速，不能推算任意生产规模容量。
- [x] 输出榜默认收起，随当前/队友视角显示干员实际HP伤害；普通战斗+联防累计，下一轮PREP冻结上一轮，正式战斗开始才清零。召唤物归root干员，装置/其他单列，不计盾/过量/友伤。
- [x] Worker约1Hz聚合、终态/重连强制新鲜；主线程绝对账本融合；Boss分组隐私、clientCombat unavailable、迟到包/换局防护齐全。后端269项、前端及相关225项通过。
- [x] 主助手真实四Chrome完成5步验收，无控制台错误；桌面/窄屏截图已看，小屏面板避开队友头像后重测通过。浏览器报告的damagePackets字段未赋值，不作为网络包计数证据。
- [x] 最终Node24 Linux组合：4001 tests / 308 suites，3985 pass、16 skip、0 fail/cancel；日志 `.cache/stardust/perf-score-canonical-final.log`。旧spectator白名单精准适配新m.damage，私密字段递归检查完整保留。
- [x] compact后核对ID/name/purpose并清理本机 `ark-damage-board-local` 临时容器，不触线上、镜像或卷。
- [x] 性能/输出榜随 `6a4d900` 已提交、推送并配套发布；生产当前v013-trialpool。新UI纠正另批验证/发布，不重跑上次激活脚本。

### 进一步总 CPU 降耗：独立试算池（2026-10-05）

详见 `.claude/trial-pool-progress.md`；用户已批准保留六个正式combat Worker，另用1–2个专用trial Worker，并顺带处理相关冗余开销。

- [x] 独立role试算池、Worker内部分片、自驱动任务、低频有界进度/终态、取消与截止/停滞监测接通；生产不暗中借用正式combat池。
- [x] summary不复制完整试算结果、可信输入复用、未发送时不构造进度DTO、stream路径不重复指纹；候选数/seed/64tick剪枝/评分与主线程权威不变。
- [x] server配置0/1/2、server-worker默认1、worker0不启动、独立health及启动失败清理/降级。core39项、接入51项、main配置7项专项通过；额外静态并发复核未发现实质bug。
- [x] 真实四Chrome分别验证6+1/6+2，每侧真实3候选/6282ticks完成；无页面错误或试算fallback，计分板live/切视角/冻结/重连/清零通过。转场结束后的截图已由main查看。
- [x] 新完整Linux Node24回归：4056tests，4040pass、16skip、0fail/cancel；日志 `.cache/stardust/trial-pool-canonical-final.log`，本机测试容器均清理。
- [x] 八个有效固定输入对照及两次独立Worker profile完成：96jobs/288候选/883456ticks、逐候选评分/赢家、正式24份终态输出榜均一致。默认6+1以成本优先：本阶段process CPU较shared6少30.35%，但批次完成约慢20%；6+2较6+1多6.54% CPU/约173MiB峰RSS，批次约快46.4%。这是trial-only+真实combat/WS，不含经济/规划/最终落子/Match指纹等，不能当完整PREP或生产容量结论。
- [x] 原自然PREP的2池步数漂移已定位到共享rngBots消费交错改变候选布局，不是Worker算错；两实际输入各自跨片/1/2Worker重放14/14通过。未为基准改生产RNG/时序，原失败和原始证据保留。
- [x] Worker活跃采样剩余主要是simulation；updateEnemy/_tickBuffs/advanceRoute/_checkBlock等留作后续有失效设计的优化依据，不把RPC次数或Profiler采样百分比当完整CPU归因。全部本轮测试/测量容器已清理。
- [x] 上述后端已随v013-trialpool发布，正式6+1配置生效；窗口经用户明确确认，旧内存对局已清。长生产浏览器验收被新UI反馈中断，记录未完成而不是冒称全部通过。

### 当前UI修正版

- [x] 统计按钮并入左下角工具栏；桌面在全屏按钮右侧，窄屏保持两行且在交流按钮右侧。输出/表情互斥，Escape关闭。
- [x] 真实干员头像、精确值Tooltip、数值/占比、冻结状态与口径说明；继续按对应视角/UID统计，不改伤害口径，不虚构DPS。
- [x] 主助手实际桌面/触屏两套四Chrome流程通过，表情六格命中/发送、头像加载、视角、冻结、刷新与下一轮清零验证；667手机横屏、400竖屏提示及截图已看。
- [x] auth实际TLS Chrome验证片头默认无、其余组装/成功/进入动画保留，旧偏好兼容、错误口令与reduced-motion通过。
- [x] 最终Node24 UI/auth相关328tests：325pass、3skip、0fail/cancel；spatial-07缓存版本与真实TLS六步通过。两套固定桌面/触屏完整游戏流程各六步通过、errors=[]，截图已由main查看。
- [x] 按用户“改完直接推送重启发版”授权配套发布v013-ui，11:34:34 +08成功，无回滚；嘉兴/宁夏记录已finalize，三服务healthy/restart0。不变更密码/签名key、6+1配置或OpenI正常分发。
- [x] 正式镜像额外296tests293pass3skip、无源码挂载桌面/触屏各六步通过；正式域名spatial07动画、双人房/重连/盟约/自动买布阵/战斗/头像输出/真实表情通过，资源响应OpenI385/NX44，main已看实际生产截图。未生产压测。

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
