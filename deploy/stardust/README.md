# Stardust 部署覆盖层

本目录版本化维护本站的认证/PRTS、Nginx、公开静态源和协同发布流程，不改变上游的项目目录结构。代码遵循仓库 GPL-3.0-or-later；第三方库按原许可证，游戏素材仍受根目录 NOTICE/THIRD-PARTY-NOTICES 的限制。

## 当前双 ingress 发布准备（2026-10-09，尚未切换）

本地271皮肤、三语音频、4步进同模式匹配、20人重复六项／四人共享池／整段联防预算及完整干员预设已经过各自本地验收。用户现明确要求每物理入口两个独立ingress，并批准改完验收后直接正式切换；另选当前功能分支本地提交＋离线镜像、重建有期限固定key loopback Core通道，不推送或合入master。目标1coordinator＋16个8+2game＋8ingress共25角色，匹配池与浏览器协议不拆分。切换结束内存房间／对局，需刷新；DNS、PRTS／口令、Beta、WG恢复依赖和其他服务保持。

双实例及WS-only代理、真实Worker＋三浏览器故障恢复和quiet同负载ABBA已验收。管理器三条异常路径已修复为dual-only schema2 journal／CLOSED ownership／逐目标准入；fresh224项Python（219通过／5条件跳过）、4native、52实际隔离kernel及限定独立复核通过。最新608文件完整回归6720项：6696通过／24条件跳过／0失败，官方283golden一致，1371代码数据库存SHA为0166ca3675702c377b6ca516895bc34ee0e63ed05d2bbe8f2f378c444a868ea5；英文及相关四包通过，全局日韩繁各382既有缺译仍strict失败。具体合同、closed guard迁移与证据边界见 [DUAL-INGRESS](cluster/DUAL-INGRESS.md)，当前最高进度 `.claude/dual-ingress-preparation-20261009.md`。此前cd523366／72e仅为历史；本地验收不代表已固定镜像、投递或完成正式25角色切换。

## 先前准备：271皮肤、三语音频与多人匹配（尚未切换）

用户本轮明确批准皮肤／音频批量准备与新immutable上传；本地还修复20人机变六项截断，容量4／8／12／16／20并支持同模式跨房间整队匹配。271皮肤已严格实装，286新增模型当前game loader／SpineActor真实浏览器通过；20真人两房匹配／手动选完／真实Worker与刷新已验收。新增皮肤真实三端游戏选择／队友默认模型／旁观私有隔离／Worker战斗与刷新、full/lite package dryrun均已通过；最终post-MIME修复599文件canonical R2已通过：6524 tests／6501 pass／23 skip／0 fail或cancel；官方283golden全部一致、六JSON前后及HEAD SHA不变。英文1611和新增161文案四包通过，日／韩／繁体各391旧缺译仍另批处理；不把全局strict失败称通过。此候选未提交、推送、构建镜像或部署。

公开物料OI86086／MS86085 aliases使用同源有界100000条和64MiB消费限制，实际大型JSON／LuaJIT／OpenResty／resolver盘读HTTP通过，仍恰2OI mirrors及唯一黑「厚礼」OpenI-only例外。供应源上传和最终核验已完成：MS固定revision `5f62fa7490c4d6ef4998aa211eb00357d7e85dce`，17277 assigned对象完整LFS SHA／size／InCheck通过；OI17278 assigned对象完整注册路径／大小及新7698 PUT-MD5通过，原objects／精确attributes保持、原失败保留。47匿名完整正文样本（24OI＋23MS，20551163字节）SHA／size／单CORS*及两项音频Range206通过；不冒称两家供应源全文重下载或新浏览器验收。Main独立核对11份proof摘要、47样本对本地正文和1360代码数据封存通过。`providerSupplyReady=true`，实际固定revision的最终本地profile绑定也已通过：38native LuaJIT向量、77实际OpenResty HTTP、resolver真实盘读和100000／100001／64MiB+1边界均验证、fixture关闭；旧synthetic-pin证明仍保留原义。MIME收尾仅让有效octet-stream不再多请求原.mp3，并非旧配音完全不能播：56聚焦、主助手三真实Chrome／本地HTTP头复现与原MP3／HTTPWS＋1Worker自然三语解码、错误中文回退及刷新通过，非直接供应源browser。最终1360代码数据SHA库存摘要72e20bf11caeb28f6e491d332f6f232292b3a74a2a4dee0c1108207225d49e7a已封存。源码／镜像／私有码尚未固定，`readyForProductionActivation=false`，不能称已上线。宁夏新immutable正文17292文件已完整远端SHA通过，不安装include、不reload或切入口。正式仍为8245/client371cbf648323/ae10，下方旧无上传许可／皮肤暂停说明属相应历史。

## 新配音功能：源码与本地素材，不是正式切换（2026-10-08）

大厅「语言」和游戏内原有设置复用同一套界面语言／中日英配音选项，偏好独立且只影响本浏览器。三语实播、缺档／加载失败中文回退及刷新恢复已在 localhost 真正的 HTTP/WS/Worker 中验收；日语191人、英语182人，全部7896录音已完整验证。说明见 [VOICE-LANGUAGES](../../docs/VOICE-LANGUAGES.md)。

本轮授权范围仅为本地验证和源码 Git 推送。新增5222录音没有上传静态源，也没有新镜像、正式／Beta切换或auth重启；线上仍为下面的8245/client371cbf648323。后续上线必须先准备同版 immutable 素材、私有码和镜像，并另获执行授权。皮肤补全仍暂停。

## 最新正式游戏：0.2.1 多人与皮肤（2026-10-08）

正式运行固定 commit `8245e2ecafba404e48536755a80c3443afdf558d` / client-build `371cbf648323`；四入口 OPEN，1 协调器 + 16 个 8+2 节点 + 4 ingress 共 21 原生角色就绪。仅好友房默认关闭的 8／10／16／20 人、条件式接力、组队准备检查、两条简洁公告和大厅群号已配套发布。皮肤当前实际覆盖 127 套／95 名干员，**不是官方全部时装**，用户已反馈缺项，另作本地补全调查。

每入口 157 个私有文件与同版素材／解析器清单核对，实际公告字节、Main-only 优先级和 40 次正常 TLS 稀疏门禁／素材检查通过；没有生产负载或新增生产玩法验收。普通公开素材仍 MS60/OI40，黑「厚礼」立绘仅 OpenI，宁夏同版 HEAD／原失败回退；PRTS ae-10、认证、代理、WG 与其他服务保持。新游戏版本与 host-only 工具／记录提交分开，不能给运行镜像重标较新文档 HEAD。

下文仍保留前一版本与准备过程作为历史。已消费控制器不重放；后续皮肤补全不自动授权另一轮素材上传、停服切换、DNS 或清理。

## 最新独立登录页：PRTS ae-10（2026-10-08）

四个正式入口已独立更新到 `ae-10`，片头仍默认跳过，界面组装、成功凭证、进入动画及无障碍/立即进入兜底保留。固定 auth-only 镜像 `ddf7f87fa8cc…`、AUTH_OVERLAY 摘要 `c44c000b5724…` 不是 Git commit 或游戏版本；完整身份见 [独立登录页记录](releases/prts-ae10-20261008-auth-c44c000b.json)。

只替换正式 auth，并修改每个正式 vhost 的三条窄 `connect-src` CSP 后正常重载 Nginx。旧授权 Cookie/CSRF 和重新入场的昵称校验通过；口令/签名文件、其他容器代次及公开素材/PRTS 基础库不变。游戏未重启、未升级本地 0.2.1，也未访问杭州 Core。门禁在启动时读取前端文件，因此此更新不是完全零重启或保证零请求损失的更新。

72 项新门禁回归、镜像真实隔离 HTTP、四入口 TLS/资源摘要/匿名门禁及主助手线上浏览器桌面/手机模拟通过。首轮工具校验失败已回滚并保留，新一轮使用真实代理配置和可信 Host 后通过；不是放宽只读或门禁。浏览器用内部内存 Cookie 检查 profile 动画，没有输入正式口令或启动游戏客户端。此发布先于源码 Git 提交与推送，后续源码/记录推送不改变已运行镜像身份。

## 最新正式游戏运行：0.2.0 联防原地图热修复（2026-10-07）

正式服已运行固定源码 TREE `80a59be2121de90eee9579a4b2b63c65ca9b7f69`，客户端标识 `7793c19cf0fc`；四入口均已解除维护，杭州 1 协调器 + 16 个 8+2 节点、四个 ingress 原生就绪。联防恢复原地图，独立热修复公告已上线；16 个节点仅更改显示名称，内部身份、路由和匹配不变，更名未写入公告。

本次只换正式角色及其配套私有代码；门禁、素材解析器、TLS、代理容器、WG 与其他服务代次保持。杭州镜像经固定密钥的直接管理 SSH 传输，无跳板或回退；通道为 12 小时临时通道，不是永久管理入口。用户明确跳过追加验收，不能把未执行的浏览器/玩法验收算作通过。完整身份、已通过验证、失败与跳过边界见 [热修复记录](releases/v020-unite-hotfix-20261007-80a59be2.json)。

TREE 不是 Git commit；后续主分支提交与推送只记录相同运行源码，不重启或重新维护正式服。发布文档留管理机/Git，不复制到杭州。下方历史章节不代表新的执行授权，已消费的一次性脚本不能重放。

## 仓库与生产是两件事

- `origin`：`git@github.com:Stardust-minus/Stronghold-Protocol.git`。
- `upstream`：`git@github.com:sganggs/Stronghold-Protocol.git`。
- 本 fork 的 `master` 是本站集成分支；功能分支验证后合并，不强推或改写已发布历史。
- 固定本地工作目录：`/root/projects/Stronghold-Protocol`。旧 `/tmp` 工作目录只作历史参考，不再作为开发主目录。
- 历史 2026-10-04 15:00 检查点：已激活 `v012-workers-20261004`（上游 0.1.2 + 固定战斗 Worker 池 + `/media/` 静态适配），运行源码固定为 `2878299`。完整镜像/资源摘要和验收记录见 [发布记录](releases/v012-workers-20261004.json)；后续仅更新文档的 master 提交不代表运行镜像改变。上一版 `8cd6491` / `0.1.1` 保留供成对回滚。
- 15:00 +08 已按明确授权将 Worker 从 4 调到 6，镜像/资源未变；见 [运行配置记录](releases/v012-workers-20261004-workers6.json)。
- 实际激活状态以两机 release 记录为准。checkout、合并与推送不自动授权部署；须完成同一 commit 的本地验收并取得上线授权，才能协调切换游戏与静态路由。

## 最新状态：杭州仅运行正式计算（2026-10-07追加）

用户追加要求杭州不留开发文档/源码副本、仅运行prod。已停止杭州17个Beta集群容器和旧Beta单体，禁用旧/Beta管理器及恢复单元；正式1协调器+16节点的原始进程代次、精确租约和健康均保持，未重启正式。Beta因此暂不可用，嘉兴的Beta入口/门禁素材在本次杭州-only范围内保留，不自动搬迁测试计算服务。

杭州16个非运行必需文档/源码暂存/旧工具树已清理，共2338条目/1.28GB；小型退役代码和历史材料先不透明保全到管理机私有归档。正式所需6个宿主程序、镜像、运行配置、密钥挂载和守卫继续保留，不能以“无源码副本”为由删除生产管理程序；Docker回滚镜像/已停止容器、受保护的停用配置与闭锁接口保留，其他K8s/AI/存储不动。

跟进记录：[杭州prod-only](releases/v014-core-prod-only-20261007-5b63d51.json)。发布文档/开发代码及后续记录只放管理机和Git，**不再复制到杭州**。以下双profile验收是停用Beta前的历史快照，不代表Beta现在仍在线。

## 正式三入口上线验收（2026-10-07，Beta停用前）

正式服与修复后的Beta均已部署固定运行commit **`5b63d51dddeba07292eb9891beee776850c1bb75`**。每个profile独立运行1个协调器、16个完整对战节点（每节点8战斗+2试算Worker），`.78/.73/.92`三个入口都能访问全部16节点，共用各自的大厅和匹配池；不是三个玩家区。`.75`因供应商UDP链路问题保持0角色/闭锁，不接流量。

- 大厅无实验设置，房间内只有房主可改，两项默认false；solo匹配跟随房间。房间按钮响应布局与真实2D/显式软件3D地图纹理已验收。
- 必需的ignored `data/local-assets.json`独立纳入资源清单：1481引用、150960字节/SHAea084e…；239提交源码与7216资源分别绑定，不能把索引当Git blob。
- 主助手五客户端跨三入口匹配、购买部署、战斗结算到第二轮、队友视角/外部观战/重连通过，最终problems0；五端音频缓存全部解码。正式与Beta各312门禁TLS检查和`.73→.92`身份/owner恢复通过。
- 按明确立即替换授权停用旧f3/be27单体及旧core管理器，旧Formal-only租约关闭；旧镜像/容器/配套文件保留。旧WG、legacyBeta、原入口auth/assets及代理代次不变，Nginx仅正常reload。
- 用户已增加正式域名`.73/.92`A；Google公共DoH已返回`.78/.73/.92`、TTL600、无`.75`。这不保证所有递归缓存立即更新或现有长连接迁移，也不是严格流量均分或协调器HA。

配套F3公开素材仍正式ModelScope60/OpenI40，字体/vendor/PRTS及HEAD/fallback保持宁夏，未重传或覆盖已发布资源。密码、门禁及仅跳片头的PRTS动画约束不变。运行源码C与后续发布记录提交分开；实机身份、完整验收、失败历史及回退见[正式集群记录](releases/v014-cluster-formal-20261007-5b63d51.json)，拓扑与运维边界见[CLUSTER-SOP.md](CLUSTER-SOP.md)。

## 历史活动状态：正式素材 60/40（2026-10-06）

正式公开 `/assets/`、`/media/` 普通 GET 已于 **17:12:58 +08** 激活 **ModelScope 60% / OpenI 40% / 宁夏 0%**，**17:19:54 +08** 完成验收。按请求随机选择，短缓存可复用同一跳转，不是逐十次严格配额。宁夏仍承担 HEAD、原 OpenI 故障回退，以及 fonts/vendor/PRTS 正文；Beta 分流不变。公开范围没有扩大到业务代码、data、认证或 WS。

本次仅宿主 Nginx/Lua 与平滑 reload；游戏、auth、resolver、OpenResty 容器均未重建。正式 game 仍为 `7e019ee36a2423393221cbba37bf60e40be35536` / image `10c94333` / CID `8715f3a3`，杭州单正式 backend、12 combat + 2 trial；Beta 为独立 C1 `1f742992` / image `14ad2e07` / CID `dd114e05`，12+2。嘉兴保留 edge auth186、resolver063及 OpenResty，不能将旧单机三服务说明当作当前计算部署。

完整源站职责、immutable revision、缓存/CORS、隔离测试、证据口径及不重启回退见 [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md)；活动记录见 [素材分流记录](releases/v013-material-lb-20261006-modelscope60-openi40.json)。ModelScope 全量库存 LFS SHA/size 已验证，但未逐对象重下载正文；实际 Chrome 完成匿名素材哈希、音频解码与 Spine 渲染，**不代表本批重新验收密码登录或玩法**。后续 Git 文档提交不改变运行 game/sourceHash；推送不是下一次切换授权。

下面的旧准备/单机架构说明保留作历史与模板参考，当前活动声明以最新 release 及实时配置为准；完成的一次性脚本不得重跑。

## 历史：独立 Beta 准备（不替换正式服）

杭州/Beta的候选规范见 [BETA-SOP.md](BETA-SOP.md)。新增Beta game/edge Compose、Beta-only vhost与私有JS/CSS落盘工具，独立房间、队列、Cookie签名及门禁Origin。`prod` 优先级profile保持嘉兴6+1/单loopback；`beta` 为12+2/3220双绑定；`core`仅未来杭州正式迁移候选12+2/3120双绑定。准备/测试/推送不意味着Beta或正式已激活；以实际验收记录为准。

正式服务仍维持下述单backend架构。Beta是用户明确要求的长期独立验收环境，不恢复rolling/drain或按版本分流。

## 历史简单单机部署：一个项目、三个服务（2026-10-04）

2026-10-04 用户取消平滑更新后，普通入口恢复 `/`，Nginx 直接到单个游戏 3120；门禁 3141、OpenI 素材解析器 3130。固定容器名 `ark-proto` / `ark-proto-auth` / `ark-proto-assets`，同一个 Compose project `ark-proto`，不运行网关、备用游戏或蓝绿素材槽位。`runtime.env.example` 只是现有镜像坐标基线，不证明本地新修改已上线。

三个服务配置均无 CPU/内存限额，PIDs/只读/安全设置保留。D71 / `v012-simple-20261004` 已在 2026-10-04 23:45 +08 完成三服务统一重建，CPU/内存 metadata 为0、project均为ark-proto；更新前仍以实时inspect核对。游戏重建会清除内存对局，更新前必须说明影响并获得窗口授权。

0.1.3发布模板保持6个正式战斗Worker，新增独立 `SP_TRIAL_WORKERS=1`（0=主线程试算，1=成本优先默认，2=较短试算排队）。它们是同一游戏进程内的线程，不是额外服务。健康接口分列 `combat` 与 `trial`，不能把正式ready读成7/8；试算故障可降级inline，不把它误报成整个游戏不可用。模板不代表已上线，实际版本以release记录和运行镜像为准。

唯一旧游戏 prefix `/_release/v012-alliance-20261004/` 临时兼容已打开页面，HTML 302 `/`、代码/WS 指同一个游戏；未知 prefix 拒绝，不生成新 prefix。root hooks adapter 直接游戏避免双 Preact；其余 vendor/字体仍宁夏，正常图片/音频通过 OpenI，故障仅同版本 fallback。历史 release 清单和 immutable 资源不删除。

## 内容

| 路径 | 用途 |
|---|---|
| `auth/` | 原生 Node 共享口令认证服务和主助手编写的 PRTS 前端 |
| `auth/test/` | 不接触生产的认证、CSRF、限速及凭据文件权限测试 |
| `compose.yaml`、`runtime.env.example` | 单 project 三服务固定名字/端口；server模式、6个正式Worker和默认1个独立试算Worker，三个服务均无CPU/内存硬上限 |
| `compose.auth.yaml` | 同 project 的门禁专用视图，只更新 auth，不新增项目/容器 |
| `compose.assets.yaml`、`openi-resolver/` | 同 project 的素材专用视图/解析器；只返回重定向，失败回退宁夏，不持有账户 Token |
| `Dockerfile.offline` | 使用已准备好的 `app/` 目录离线构建，需传入实际 commit/version |
| `nginx/` | 基于实际 direct3120 的嘉兴 OpenResty vhost、正常 root 入口/解析器 snippets |
| `static/` | 宁夏公开静态源 Nginx 与 Supervisor 配置，10 workers；CORS `*`，无凭据 |
| `tools/prepare-auth-assets.mjs` | 从本仓库 lockfile 对应依赖和已安装字体准备 PRTS 的忽略文件 |
| `tools/prepare-static-release.mjs` | 离线准备/校验素材、字体、vendor、音频 alias 和逐文件 SHA-256 清单 |
| `tools/openi-assets.py`、`OPENI.md` | OpenI 镜像上传/校验、无扩展名音频映射、签名缓存及同版本回退；旧单源状态标为历史 |
| `MATERIAL-SOURCES.md`、`releases/v013-material-lb-20261006-modelscope60-openi40.json` | 当前正式 ModelScope60/OpenI40 分流、固定 revision、证据口径与回退边界 |
| `material-lb/access.lua`、`material-lb/header.lua` | 当前 C1/60:40 宿主 OpenResty profile 模板；不是容器新实现或通用 provider 开关 |
| `tools/prepare-material-lb.py`、`tools/test-prepare-material-lb.py` | 离线生成/验证当前 profile 与本地测试；无上传、激活、远端操作 |
| `WORKERS.md` | Worker 边界、故障策略、回退、健康指标与本机性能样本 |
| `MAIN-THREAD-PRIORITY.md`、`main-thread-priority.example.json` | 宿主机默认仅游戏MainThread nice=-20；固定镜像/源码白名单、验收与停用；入库不代表已安装 |
| `tools/main-thread-priority.py`、`systemd/ark-main-thread-priority.service` | 普通调度reset-on-fork继承保护与Docker启动事件钩子；不改容器权限、Node入口或其他线程 |
| `UPDATE-SOP.md` | 游戏、素材、字体、vendor 的配套更新、验收及回滚步骤 |

## 本地准备与测试

根目录先完成上游依赖/素材准备；素材必须在可联网机器准备，不在国内生产机临时下载。已经有完整素材时不要重复运行联网 setup。

```sh
npm ci
# 按上游说明准备本地素材，至少包含 public/fonts/bender-regular.woff2。
node deploy/stardust/tools/prepare-auth-assets.mjs
node --test deploy/stardust/auth/test/*.test.mjs
npm test
```

`prepare-auth-assets.mjs` 不联网：从 `node_modules/three` 生成带 MIT 说明的 Three.js/Core/CSS3D 文件，并复制 Bender 字体。生成文件已忽略，不提交第三方构建产物或游戏美术。

凭据权限测试在非 root/Windows 下会跳过需 chown 的部分；认证协议测试仍运行。测试密码仅为代码中的明确测试值，不是生产口令。

原生认证单独运行时要用测试配置文件，通过 `AUTH_SECRETS_FILE` 指定；不要读取生产秘密来做普通开发测试。生产改密工具仅通过 TTY 隐藏输入，秘密存放在仓库外，重建门禁不会重启游戏。

## 简单 Nginx 的隔离验收

`nginx/test/simple.test.mjs` 测试正式模板（仅替换本地端口、证书和路径），临时单个 Node24 fixture 内运行真实游戏/门禁/解析器，签名 API 仅注入 test-only reply，不请求公网或更改生产/系统服务。所有临时监听/容器自动清理，不是增加部署服务。

```sh
SIMPLE_NGINX_SMOKE=1 NGINX_BIN="$LOCAL_NGINX" \
  node --test deploy/stardust/nginx/test/simple.test.mjs
# 真正带Lua的OpenResty可额外设置 NGINX_HAS_LUA=1，测原presence聚合正文。
```

无 opt-in/binary 时 smoke 明确 skip。stock Nginx 无 Lua 时仅把测试配置的 presence 正文换为一个正常 content-phase proxy，仍验证其门禁和内部健康不外露；实际 OpenResty 聚合子测试明确 skip，不能以它冒称正式 OpenResty 完整验收。游戏/auth/resolver 运行时必须为 Node24；本机测试编排可使用其他 Node，但报告须区分两者。此测试覆盖 root/唯一旧prefix的HTTP/WS、PRTS marker、严格Origin、匿名门禁、公开CORS、OpenI两模式/同版本fallback及root hooks单身份，不代替主助手真实浏览器画面/交互验收。

## 离线构建约定

游戏离线构建上下文是一个**新生成目录**，包含完整的 `app/`（依赖、vendor、素材都已校验）以及本目录的 `Dockerfile.offline`，不是直接对仓库根目录执行该 Dockerfile。

```sh
# 在已经准备并校验好的构建目录中执行；值必须与其 app/ 内容一致。
docker build --network=none --pull=false \
  --build-arg SOURCE_REVISION="$SOURCE_REVISION" \
  --build-arg APP_VERSION="$APP_VERSION" \
  -f Dockerfile.offline -t "$IMAGE_TAG" .
```

认证镜像的上下文为 `deploy/stardust/auth/`，构建前先生成依赖文件。镜像不包含秘密配置。

## 追上游

```sh
git fetch origin
git fetch upstream --tags
git switch -c sync/upstream-YYYYMMDD origin/master
git merge --no-ff upstream/master
# 处理冲突、检查下列接点、跑测试后，再合并回本 fork master。
```

必须检查：数据/素材 manifest、lockfile/vendor、`/assets` 及新的资源路由、`/ws`、昵称/重连约定、认证外层接点，以及模拟/Worker 改动。

**特别注意**：原作者在 `8cd6491` 之后增加了 `/media/` 无扩展名音频路由。本覆盖层已加入配套分流生成器与实机 Nginx 测试；以后更新仍须审查 `shared/media.js`、音频扩展优先级和素材清单，不能只保留旧 `/assets/` 重定向，或将无扩展名 URL 又重定向成 `.mp3`。

先准备同 commit 的游戏和静态资源，按 SOP 协同切换；回滚同样成对进行。PRTS 基础库独立版本化，不跟游戏每次更新强制变化。

## 安全与公开范围

禁止提交：真实密码、会话Cookie、scrypt verifier/签名密钥、SSH/DNS API凭据、账户Token、私钥、证书、ACME账户、签名URL query、素材/vendor正文、日志内容、带用户信息截图或生产数据导出。公开artifact hash、固定revision及必要host-only路径可记录；完整运维证据保持Git外。`.gitignore`/`.dockerignore`是辅助，不替代提交前人工检查。

静态源公开的是 assets/fonts/vendor 和 PRTS 的稳定图形库/字体。CORS `*` 不意味着游戏 API、WebSocket 或认证开放；也不保证当前带 Preact 导入适配的 vendor 对其他部署完全通用。

证书目前是手动 DNS-01，材料在仓库外，没有自动续期。不要将持有域名 A 记录或当次 TXT 当成自动续期方案。

## 游戏 health 性能指标（本地实现，非上线记录）

游戏 `/healthz` 新增独立 `performance` 缓存；原 `ok/combat/trial` 字段和 HTTP 判定不变：inline 返回健康，正式池仅要求 `status === 'ready' && ready > 0`，不要求全部6个ready。试算池降级、性能采集失败均不使健康接口变503。现有队列/active/cleanup/replacement等计数仍直接来自原池，不新增RPC或重复计数。

采集器只在HTTP监听成功后启动，每10秒独立采样一次；GET/HEAD只读同一缓存，不触发采样或直方图reset。`sampledAt` 为Unix epoch毫秒，`windowMs` 是两次采样之间的实际单调时钟时长（定时器延迟时可大于10000），不使用墙钟差值或固定10秒计算CPU百分比。`status` 为 `warming`（冷窗口）、`ready`、`unavailable`（初始化/采样失败）或 `stopped`（实例关闭）；冷窗口全部测量值为null，空直方图的延迟分位数/max为null，不伪造0或输出哨兵/非有限数。

| 字段（相对 `performance`） | 单位与口径 |
|---|---|
| `mainThread.eventLoopDelayMs.{p50,p95,p99,max}` | 主线程 `monitorEventLoopDelay` 窗口统计，纳秒换算毫秒，采样分辨率20ms；20ms附近的基线不是业务/WS网络延迟，也不是Worker循环延迟 |
| `mainThread.eventLoopUtilization` | 主线程累计active/idle快照的窗口差值ratio，范围0–1；不是整个进程CPU占用 |
| `process.cpu.{userMs,systemMs,totalMs}` | 进程累计CPU微秒快照的窗口差值换算毫秒，包含combat/trial/V8等线程 |
| `process.cpu.percent` | `totalMs / windowMs * 100`，一个CPU核满载=100%，多线程允许超过100%；不按宿主核数归一化 |
| `process.rssBytes` | 全进程RSS字节，不与各Worker RSS重复相加 |
| `mainThread.memory.{heapUsedBytes,heapTotalBytes,externalBytes,arrayBuffersBytes}` | 调用 `process.memoryUsage()` 的主线程对应内存字节，不是所有Worker堆之和 |

定时器unref只防止阻止进程退出；实例幂等close入口会先清timer、disable直方图，再等待Worker池关闭。采集部分初始化/采样失败会释放资源、一次性记录日志，并只标记指标unavailable，不影响游戏继续服务；不新增服务、端口、配置或依赖。

访问保护仍依赖现有Nginx和loopback部署：公网 `/healthz` 保持404，内部健康子请求边界不变；原生游戏HTTP本身没有独立health鉴权，切勿直接公开游戏监听端口。`/client-build` 仍只返回build标识；presence不转发这些性能/内存/会话诊断。这里仅说明待发布代码的口径，不表示当前运行镜像已经包含这些指标，auth/assets接口与部署健康判定均不改。

## Worker 开发状态

固定池已实现，`SP_COMBAT_WORKERS=0` 保留原后端，生产目标为 6 Worker；不引入 Redis，不改变前端协议。`maxRooms` 默认 4096。确定性、Boss 共享池、暂停在途回包、动态元数据重连、退出/取消、迟到消息、线程故障与关闭均有专门测试。详细范围、故障行为和容量限制见 [WORKERS.md](WORKERS.md)，实际线上启用状态仍须核对 release 记录及 `/healthz`。
