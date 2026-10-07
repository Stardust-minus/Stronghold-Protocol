# Stardust 当前开发 TODO

## 当前收尾：正式集群已切换 / 发布记录与仓库整理（2026-10-07）

用户授权本批推送和正式上线，并明确“可以直接停旧正式服替换上线的”。固定运行源码`5b63d51dddeba07292eb9891beee776850c1bb75`已非force推至origin/master，随后停用旧f3单体并切换公开入口。后续发布记录提交不是新的游戏镜像。DNS由用户操作，不因“准备添加”推断助手获准修改。

- [x] 房间小fix已上线：大厅无实验设置，仅房间内房主可改；按钮放设置区，实际镜像12组布局和三入口横屏准备按钮不重叠通过。
- [x] 必需生成索引已纳入独立资源清单并恢复Beta/Formal真实2D/3D纹理；150960字节/1481引用/SHAea084e…，不是Git blob。239提交源码+7215公开资源+生成索引=7216资源。
- [x] P1终态有序控制通道/撤权fail-closed/正常release提前关闭竞态已成套部署；实际镜像244聚焦回归通过，不混新协调器与旧节点。
- [x] 正式及Beta各1协调器/16个8+2节点/3入口，40个活跃角色精确初始代次、租约、Main-only-20/reset/其它线程0最终核验通过；`.75`双profile均0角色/闭锁，不接流量。
- [x] 三正式站点与TLS/共享prod Cookie/Origin/CSRF/104私有码匹配，正式/Beta各312真实TLS响应检查通过，跨profile Cookie互拒；`.73/.92`复用既有代理，原bind inode和Beta前缀保留，无第二443代理。
- [x] 新C实际`.73 → .92`观战身份及同owner恢复通过：Formal game-09、Beta game-04，观战私有帧0/内部路由帧0。
- [x] 旧正式be27/f3已停止，旧core管理器禁用/旧Formal-only租约关闭；旧容器/镜像/配套配置保留，旧WG与legacyBeta ecd不动。切前实际447online/440rooms/413matches，不冒称零局或无损切换。
- [x] 全36旧分支和唯一snapshot外部bundle保全；两stash、upstream、tags保留。
- [x] 本机9950X隔离100/500/1000真实WS控制面短测，21,815请求0错误；没有生产TLS/分配/实战压测，1000只是测试上限，不承诺生产人数。
- [x] Node24显式380文件/4717tests：4700pass/17skip/0fail，133goldens基线不变；最终Python338/7skip，native两profile8+2、fresh-netns角色20/WG32通过。初次失败及修复记录保留。
- [x] 正式五客户端最终R7严格验收：完整玩法/2D与显式软件3D纹理/购买部署/观战重连到第二轮通过，problems0；五端音频14/13/13/14/14缓存全部解码，0失败。159次取消逐条绑定audio.js实际body.cancel、200非音频MIME及同源media重定向链，非笼统忽略ERR_ABORTED；旧失败记录保留，无TLS绕过、无运行代码/素材修改。
- [x] 同版本发布记录及五机双profile运维副本已写入，SOP/活动基线更新；不重启服务、不改素材/证书。记录`v014-cluster-formal-20261007-5b63d51.json`，运行commit C与记录提交分开。
- [ ] 发布记录提交/快进master/非force推送核对；删除已合入或已精确归档的本地及origin非master分支，最终仅master，不清镜像/证据/stash/upstream。

`.78/.73/.92`已验证共用同一正式大厅与全16节点，用户可新增`.73/.92`同域名A，不需重启协调器/游戏；`.75`未恢复不能加入。DNS不严格均分、不迁移现有长连接，也不等于协调器HA。

## 历史已上线Beta批次：四入口目标 / 十六后端 / 实验性选项（2026-10-07）

用户已提供新机115.231.235.75/.73/.92，加原.78共四台8C16G/独立100M；干净Ubuntu22.04、免密SSH实测通过。明确授权机器配置、代码修改和完成后部署Beta，用户睡觉期间由助手负责。不改正式服、不改DNS、不默认commit/push/master整合；历史授权不复用。

Beta 已于 **2026-10-07 04:33:06 +08** 切换到新集群，公开 DNS 仍指原 `.78`；`.73`、`.92` 已按指定端点完成同域名 TLS/门禁/玩法核验。`.75` 暂不接流量，见剩余项。活动记录：[v014-cluster-beta-tree-f739-20261007](deploy/stardust/releases/v014-cluster-beta-tree-f739-20261007.json)。

- [x] 主助手统一并缩小连接状态/延迟控件，移除常驻冗长说明；大厅实际显示16个游戏节点，对局内只显示当前owner，桌面/手机横屏模拟截图亲自查看。
- [x] 房间“实验性选项”：两项默认false；房主设置、取消开局投票、solo公开匹配随匹配房间。独立卡池保持正常copy cap，实际三入口party+solo组局继承通过；原救援条件/状态保留。
- [x] 16个杭州后端8combat+2trial与单全局协调器实际部署。三个已启用入口均路由全部16节点，非四个玩家区；所有活跃角色健康、Main-only-20/reset/其它线程0和精准租约实机核验通过。
- [x] 新三机基础包、独立WG/精确防护/角色材料和恢复单元安装；旧WG、正式游戏/门禁/素材、其它服务未重启或修改。新代理非root worker、只读代码/TLS及独立日志/tmpfs。
- [x] 指定首条公告替换为正式玩家口吻，强调集群化分布式计算、不暴露机器/线程/路由；欢迎与联系方式保留。完整Node24 canonical4703项：4686pass/17skip/0fail，133goldens基线不变；host33/WG23项通过。
- [x] 固定TREE字节身份f739（不是Git commit）、239源码/7215资源/104私有代码，匹配现用已发布F3素材；Beta-only受控激活及回退材料保存。三个入口312个私有代码正文/HEAD/304/过期Cookie/Origin/CSRF等实际TLS检查通过，Beta Cookie不能进入正式。
- [x] 主助手5个实际incognito Chrome客户端：跨三入口组队+solo匹配、实验设置、购买/画布部署、首战结算至第二轮、队友视角/外部观战/重连通过，最终problems0/观战私有帧0/内部路由帧0。另有实际`.73`→`.92`观战身份与同game-03 owner恢复通过（INFO_CHECK阶段）。
- [ ] `.75` 外层UDP51838尚未观察到杭州来包/WG握手，配置材料已备但ingress/web未激活。正常入口观察到杭州按目的端映射的不同公网端口，不能猜端点或绕过已固定WG恢复CAS；仍需排查该独立链路，再完成第四入口真实业务核验。
- [ ] 整机重启、实体手机与实际口令录入未验收；不把隔离恢复/内部授权Cookie/模拟手机当作这些验收。没有生产压测/容量倍数承诺。
- [ ] 正式切换、四入口DNS及Git提交/推送/master整合仍等待后续明确许可，不因Beta完成自动执行。两个历史stash保持。

## 历史基础开发批次：统一匹配 / 多实例 / 多入口（2026-10-06；状态由上方覆盖）

用户已要求开工，并于2026-10-07确认嘉兴共四台机器，每台8C16G、独立100Mbps。目标是先单入口＋多杭州计算实例上线，随后预核验新入口并加DNS无缝扩展；同一大厅与匹配池，整局固定一个游戏节点，队友视角、外部观战与重连必须保留。当前仅授权本地实现和隔离验证，不切换/重启正式或Beta，不修改现有DNS/WG/认证/宿主规则，也未授权本批commit/push。分支 `feat/unified-game-cluster-20261006`，base4182b37；正式仍f3，Beta仍7b。

- [x] 分离边界核对：Match保留玩法与Worker计算，平台会话/房间/队列由协调层管理。跨进程分配需要prepare/重验/commit/publish及取消补偿，不能直接随机LB `/ws`。
- [x] 房间/会话归属目录、短期上下文绑定入服票据、认证防重放且有界的私有控制RPC。Node24.14.0隔离44项单测通过；这是基础模块验收，不是多实例整条链路通过。
- [x] 独立GameHost/真实Match/进程自有Combat及Trial池接入，显式服务器权威计算、10Hz和既有压缩白名单；gameRuntime默认12+2，本地真实进程测试2+1，不恢复客户端默认计算。
- [x] 全局组队/offer的异步分配、幂等入服、失败保留原friend房与票/FIFO/TTL、迟到回复fencing、Node20s未发布回收、双epoch终态分片/个人回放与原房间恢复；原party回归保留。
- [x] 多入口路由和游戏数据直达；原生两入口/两节点＋真实Lobby验证，追加到四入口及热追加计算节点不重启/不挪旧局；append-only配置SIGHUP，先更新全部入口再启用新计算，身份/URL/key不可偷换。
- [x] 主助手真实Chrome5客户端、五个独立Node24进程、真实Match＋2+1pools：四人跨入口匹配/初始选择/首战、队友视角、外部观战、跨入口恢复、私有帧隔离和手机横屏模拟截图通过。fixture URL注入，不是实际密码/DNS/实体手机或容量验收；未购买/部署干员，未做完整实战结算。
- [x] 本批正确显式git清单Node24 canonical：375files/4646tests，4629pass/17skip/0fail/cancel；full133golden7pass、不改基线。第一遍Docker自动发现误扫ignored历史构建副本，已核对仅本地测试容器并停止，日志保留、不算有效回归。
- [ ] 进一步实际购买/部署干员、完整结算和联防/Boss/复活传输接受；首次真实Chrome通过不等于所有玩法场景已验证。
- [ ] 新入口部署模板、独立密钥/一致版本/门禁/私有码/素材清单、精确WG/宿主管理边界及回退说明。新机器访问资料尚未提供；正式接流量需另行授权。

以下旧准备与完成记录保留历史，不覆盖当前正式0.1.4/10Hz/PMDon，也不是重新部署的许可。

## 最新完成：正式 WS 压缩与公告（2026-10-06 14:30）

- [x] 用户明确批准压缩、立即维护切换及本批commit/push；正式固定game `7e019ee3`/image10c94333/CID8715f3a3，12+2/Main-only-20/reset/其他0。公告已改为全服务端演算、计算后端升级、预计体验改善。
- [x] 采用level6/512B/双向禁上下文/window12/mem5/concurrency8，UV默认4不变；凭证/控制消息不压缩，保留准入、解压后64KiB限制与背压。
- [x] Node24完整4284测试（4267pass/17skip/0fail）、候选镜像19项、真实Worker/观战路径通过；公网实际协商及按字节阈值的压缩标志、双人+两AI战斗/结算到第二轮/重连通过。只清理自己的测试房间。
- [x] 现有C1同字节私有代码/素材复用，无资源上传；Auth/resolver/OpenResty/WG未重启，Nginx未改/reload。Beta仍C1且代次/租约保留，本批不自动同步。
- [x] 发布与回退记录：`deploy/stardust/releases/v013-ws-compression-20261006-7e019ee3-r2.json`；旧镜像/config/env/compose备份保留，不能恢复已丢内存局。
- [ ] 长时RSS、自然峰时CPU/带宽观察是后续项；本次不生产压测/Inspector/heapdump，不承诺公网总流量减少68%。可选WebP仍未执行。

下方迁移/同步基线与旧准备行均为历史，不代表当前正式仍是1f742992。

更新时间：2026-10-06。正式入口已于10:32:42+08切到杭州，游戏source `1f74299291f07e100ca6f522721a29d4c474294c` / release `v013-hangzhou-20261006-1f742992`，12combat+2trial、MainThread nice=-20/reset-on-fork、其他线程0；旧嘉兴计算已于10:48:54停止并保留回退。新上游a9dfd17、欢迎公告、伤害单图标和负载提示已正式上线；7214素材及1685新增音频配套发布到宁夏/OpenI并核验。实际正式双人WSS、战斗/购买部署、首轮结算至第二轮、战斗重连和自建房清理通过。游戏固定1f74299，解析器固定0635506，不能把文档HEAD当运行版本。11:28 Beta已同步同一游戏；11:42两端WG恢复及杭州管理器开机自启已配置/启用，现网代次保留，180项Python与6项隔离内核测试通过；未做整机实际重启测试。用户明确跳过重复Beta玩法验收，可选WebP仍后置。实际记录 `deploy/stardust/releases/v013-hangzhou-20261006-1f742992.json`；下面旧准备行和许可是历史，不可重复创建Beta或重跑activation。

## 本轮收尾完成：Beta 同步 / 开机恢复（2026-10-06 11:42）

- [x] Beta 同步正式已验收游戏1f742992，保留独立域名/认证/房间，12战斗+2试算；复用已验证镜像和配套素材，更新101私有代码URL及解析器0635506。
- [x] 用户明确要求跳过重复Beta浏览器/实战验收，已跳过；只记录镜像/源码/清单/健康/Worker/只读优先级检查，不冒称重新实战通过。
- [x] 两端WG恢复程序e6087bf固定投递，180项Python及6项隔离真实内核测试通过；现网幂等调用不改接口/路由/规则/manifest/已开租约。
- [x] 嘉兴/杭州WG恢复服务已安装并enable；杭州core/Beta管理器Requires/After WG且enable，原运行代次保持，未重启正式游戏或共享主机。
- [x] 嘉兴Nginx仅消除variables hash告警及补齐两game上游HTTPidle4s，正常reload；WS/gate/TLS/资源与单后端结构保留。既有其他chat站http2弃用告警未越界修改。
- [x] 发布/回退记录补齐。Beta记录 `deploy/stardust/releases/v013-beta-sync-20261006-1f742992-r2.json`，开机恢复说明 `deploy/stardust/WG-BOOT-RECOVERY.md`。
- [ ] 可选12张纹理WebP转换；原PNG正常，不为此重启正式服。整机实际重启验证未做，不把隔离测试当整机测试。

以下旧准备条目仅保留历史，不是待重复执行任务；胜利回放和归档性能工作也不纳入本轮。

## 历史准备清单：杭州迁移 / Beta 验收 / 发布准备

本批测试通过后提交/推送与现在正式迁移均已分别获得明确授权；不进入plan模式。Beta已真实部署并完成两轮玩法/试算/重连验收，保留独立会话。迁移前完成上游同步和配套资源、保留精确回退；不因授权而跳过真实性/门禁/隔离核查。嘉兴公网上下行各100Mbps，杭州移动1Gbps，游戏经WG直连，不经SSH管理网关中继。

### 已完成

- [x] 核心机器与链路调查：杭州双路Gold6548Y+、64物理核/128线程；调查时CPU平均约1.4%，不是长期独占资源保证。当前入口反代不会省掉玩家公网输出带宽。
- [x] 独立WG实际建立：嘉兴 `10.253.77.1/32` ↔ 杭州 `10.253.77.2/32`，只路由对端/32，MTU1420；不改默认路由/DNS、不承载游戏、不自启。
- [x] WG双向ping和DF/MTU通过；短窗口RTT约6–9ms、ping无丢包。TCP两向限速10Mbps×10秒通过（一方向20次重传、另一方向0）；UDP两向10Mbps×5秒无丢包、jitter约0.097/0.027ms，有少量乱序。不冒称100M/1G满载或长期稳定性已验收。
- [x] 实际发现Calico重排INPUT导致旧隔离检查拒绝，已停止测试、撤回本次规则，改为独立native nft隔离表再复测通过；没有修改共享CNI规则。临时iperf/listener/测试端口许可已清理，WG保留运行；正式容器/source/restart/6+1/nice未变。详细非敏感资源与停用步骤见 `.claude/wg-test-progress.md`。

### 下一步，按顺序逐项推进

1. [ ] **固定候选版本及配套发布材料。** 以已验证/推送的固定commit为基线，区分源码、镜像与实际运行版本；准备游戏、宿主优先级工具及匹配的素材/fonts/vendor清单、哈希和回滚材料。不混入性能stash、第三方fork或官方未合并PR，不覆盖immutable旧资源。
2. [ ] **杭州隔离游戏部署。** 先不接正式域名、不混正式会话；用户允许使用更多计算线程，以12combat+2trial为测试候选，与6+1比较，再决定上线参数，不按128线程开满。配套适配health/优先级工具的线程数与拆机端口门槛，仍仅Main默认-20、其他线程0及继承保护，不给容器加CAP_SYS_NICE。WG业务端口/容器访问须精确放行；目前测试ACL不代表游戏已可达。正式启用前准备WG开机恢复、状态监测及精确停用，不留下测试listener。保留杭州现有K8s/AI/存储/隧道服务。
3. [ ] **长期Beta验收入口。** 新建 `ark-proto-beta.stardust.matce.cn`，由嘉兴入口经WG到杭州的独立Beta backend，供用户此次及以后上线前验收。Beta与正式不共享房间、匹配队列和内存会话；核对DNS/TLS、门禁、Origin/Cookie范围、真实客户端IP与WS。不能只把Beta域名指向正式游戏，也不恢复rolling/drain/多版本路由架构。当前未创建域名/vhost/证书或Beta实例。
4. [ ] **嘉兴本地业务静态供给/缓存。** 考虑部分JS/CSS按固定版本本地供给，减少杭州回源；优先在Beta验证。保持原门禁，明确版本键/失效/缺失回源/配套回滚，避免旧前端配新backend；不缓存WS、动态API或鉴权结果，不把业务代码并入公开素材CORS范围。大型素材继续现有宁夏/OpenI路径。
5. [ ] **Beta真实验收。** 登录及PRTS动画、真实双人房间/WS/战斗/试算、重连、匹配/复活、Boss输出板、大厅公告与整屏布局；核对版本/静态资源/cache命中、Worker布局和主线程优先级、WG访问隔离及运行表现。主助手直接实现/实际看图验收前端，不生产压测；没有真实通过就不标完成。
6. [ ] **上线前准备与明确切换时刻。** 用户确认UTC+8每天 **05:00–08:00** 为流量低谷，预计在该窗口同时更新版本+切换服务器。先完成候选/Beta验收和配套回滚，再明确具体切换时刻；现在不切、不重启正式game、不设置自动任务。说明旧房间/对局/session在内存，不能跨机无缝迁移，回滚镜像也不恢复已丢的局。
7. [ ] **窗口内正式切换及复核。** 仅在明确执行指令/窗口下协调游戏backend、嘉兴缓存和配套静态版本；复核正式域名门禁/WS/资源、实际image/revision/线程数/nice、健康及延迟/队列/带宽，并保留精确回退。Beta继续作为后续发布前独立验收环境；不自动删除旧镜像、素材、其他服务或玩家房间。

### 新增UI待办（2026-10-06夜间追加）

- [x] **伤害统计图标按钮（候选代码与本地验收完成，未上线正式）。** 改为仅显示一个小图标，复用旁边按钮的尺寸/风格，保留tooltip/可访问名称、开关语义和触屏命中区；修正窄屏旧last-child隐藏规则，伤害板/表情互斥与ESC不变。主助手实现并实际看图。
- [x] **延迟旁的服务器负载状态（候选代码与本地验收完成，未上线正式）。** 与网络RTT分开显示游戏服务主线程响应压力；复用10秒缓存ELU/loop-delay，通过现有pong传有限枚举，不新增轮询，不以在线人数或未归一化CPU百分比代替，不公开原health/内存/PID。旧pong/采样初期/断线显示未知；阈值、兼容与缓存生命周期需测试、Beta实际验收。

### 暂不混入本轮

- 胜利返回后旧结算重放、进一步CPU算法优化/绑核、官方新提交同步另列范围；不自行恢复归档性能原型。
- 本批已明确获测试通过后commit/push许可，包含Beta准备及候选改动；正式切换仍独立授权。用户希望明早可切换，预备/验收未过就如实报告，不以时间自动发布。没有cron/自动05:00切换任务，不因compact触发操作。

## 已完成代码批次：默认主线程 nice=-20 / 推送（未部署）

- 用户追加“nice默认设置-20吧，推送。然后继续看”，批准新计划；允许将下方已验收Boss/大厅功能及宿主启动策略提交、快进master、推送origin。仍不授权生产安装/启用服务、部署或重启；用户计划完成后compact，不开始其他未指定任务。进度见 `.claude/main-priority-default-progress.md`。
- [x] 宿主机Python标准库helper，默认只Main=-20；先普通调度reset-on-fork再nice，不改其他线程、Node入口、Worker源码/数量、容器权限/配额或其他服务。root管理的完整revision/image ID成对白名单、Docker init与Node分辨、PID/startTicks/标签/健康/安全门槛、事务回滚、只读check及事件驱动watcher；systemd模板只入库。
- [x] Python安全单测40/40（含只读审查发现的post-readiness瞬时失败丢失start事件，已补确认回滚后的3次/总deadline重试及不安全回滚拒绝重试）；本地实际Node24两fixture通过：真实6+1、新建与正式/试战替换Worker、独立人工fixture证明懒创建libuv nice0、幂等/显式恢复、Docker重启、真实事件自动重建、watcher完成事务后停止保留设置。首次随机port重启变化被拒及后续Docker旧事件ID模板错误/driver过早停止触发事务回滚均留证，不宣称首轮全通过；当前Actor.ID模板与完成日志等待均修正，自己的容器均removed。
- [x] 本批最终Linux Node24 canonical：333文件 / 4161tests / 309suites / 4145pass / 16skip / 0fail/cancel，并发4，162.338s；日志 `.cache/stardust/lobby-announcements-canonical-c4-84fq1xja.log` 与显式.files.json。Python40/40及实际Node24两fixture另行运行，不声称由Node清单覆盖。提交结果/远端完整SHA以 `.claude/main-priority-default-progress.md` 的实测交接为准。
- 未来经部署许可，宿主材料单独从固定提交导出/哈希校验并按 `deploy/stardust/MAIN-THREAD-PRIORITY.md` 安装。当前生产未安装启动钩子，仅保持此前手动Main=-20；容器重建仍默认0。两个归档stash保持，不移植第三方fork/官方未合并PR。

## 最新运行参数：主线程 nice=-20（非代码发布）

- 用户在-2/-5/-10/-20四次短时对照全部恢复0后，明确要求“我觉得直接干-20吧”。2026-10-05 22:56 +08起，仅当前线上游戏MainThread保留nice=-20，现有Worker/V8/libuv等线程仍0；普通调度策略、6+1、配额/亲和性/网络、其他服务均未改，无重启或部署，source186/v013-ui/restart0不变。
- 22:57独立20s只读核查：Main -20/其他角色0，6+1 ready、replacements0；有减少调度等待的趋势，未宣称战斗卡顿已根治。证据与权限边界见 `.claude/combat-stutter-progress.md`。
- 此次现场手动设置只对当前进程生效，无启动持久化或自动重施；重建会默认0，新线程继承需核对。用户随后授权上方宿主启动默认策略入库/推送，但尚未安装到生产。不要按旧试验记录恢复0、重跑调优、给容器加权限或擅自启用新工具。

## 最新本地批次：大厅公告 / 整屏布局（未发布）

当前 `feat/lobby-announcements-20261005`，保留下方已完成的Boss修复；原只做本地的许可已由用户新请求扩展为上方提交/推送批次，仍不deploy/restart。前端原验收见 `.claude/lobby-announcements-progress.md`。

- [x] 大厅顶部可点击打开公告板，独立版本内容文件、加载/空态/失败重试、可访问弹窗与原生触屏正文滚动；公告失败不阻止游戏。
- [x] 大厅缩紧卡片/间距，小横屏三模式横排、四难度2x2与header/加入区重排；匹配各状态主要操作不需上下滚动，完整协议/复活规则可点击查看，房间默认规则不改。
- [x] 主助手真实Chrome桌面/触屏/安全区82项布局检查；最终公告加载分层后5步真实交互/四人匹配/房间与结算返回补验通过，截图已看，failed尝试保留。最终Node24显式Linux：333文件 / 4161tests / 4145pass / 16skip / 0fail/cancel，并发4，163.321s；首次完整回归公告依赖扫描失败已通过大厅层加载/纯展示分离修正，未改旧playtest3断言；既有观战测试一次AI抢选固定盟约失败，未改其输入/断言或服务端，独立44/44及最终完整回归均通过。自己的测试容器均清理；本功能纳入上方提交/推送批次，未上线。

公告维护：修改 `data/announcements.json`，有序数组条目为 `{ "title": "标题", "date": "YYYY-MM-DD", "paragraphs": ["纯文本段落"] }`，date可省略；新条目放在前面。正式文件初始 `[]`，待提供实际文案，不把本地测试公告提交为真实公告。随游戏版本发布，旧已打开页面需刷新；无网页后台或热更新，保留 `/data/` 门禁，不放公开素材目录。

## 最新收尾：性能归档 / Boss 双人输出（本地未发布）

原分支 `fix/boss-damage-board-20261005`，基线为已推送的 `f54c47c`，现有改动已保留在大厅分支并纳入上方新许可的提交/推送批次；原验收见 `.claude/boss-damage-progress.md`。尚未部署，不与归档性能原型混合。

- [x] 用户明确停止继续性能优化。profile、明细表/本地火焰图、审计及失败尝试保留；A评分原型单独stash `e9b7bd96fd4a11d942b584d950c222729d3dedaa`，旧stash保留。原型通过局部正确性/状态审计，但候选普通A/B计时未启动，没有收益结论；不纳入发布或自行恢复任务，见 `.claude/main-hotspots-progress.md`。
- [x] 普通Boss/隐藏Boss输出板按当前实际战场的1–2名成员展示，双人各自姓名/小计/干员/本人占比与合计；不混入另一组，单人/普通/整备与联防规则保持。仅前端展示修正，不改计分/共享Boss血池/权限。主助手亲写并以真实6+1、四Chrome桌面/触屏验证两种Boss的独立分场、真实贡献和重连；共用滚动/表情/Escape/查看限制在普通Boss完整验收，隐藏Boss聚焦其分组/标题/数据/重连，截图已实际查看。
- [x] 本地修复纳入上方已获许可的Boss/大厅/默认优先级提交推送批次；仍未上线，当前生产186。凌晨发布继续独立遵循配套SOP，未设自动任务，不因测试/推送重启生产。

## 此前已推送批次：热键 / Boss 缩放 / 可靠性 / health（未发布）

开发分支 `feat/reliability-health-20261005`，基线 `ff3cf3e`，已提交并推送 `master/origin/master=f54c47c`；详见 `.claude/reliability-release-handoff.md`、`.claude/reliability-health-progress.md` 与 `.claude/unite-board-progress.md`。用户要求凌晨再重启更新；尚未部署，以上生产记录不变，不能现在重启。不提前合入官方未合并 PR（包括 #109/#115/#126），只按用户批准做独立小改动。

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
- [ ] 发布仍未执行；最新用户窗口为UTC+8每天05:00–08:00，当前先准备杭州/Beta及配套发布材料，具体切换时刻未定、未设置自动任务。以上方最新清单为准；旧activation脚本和旧发布许可不复用。

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
