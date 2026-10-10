# 统一匹配与多入口集群部署

本文描述固定 profile 的架构、准备与运维合同，不声明任何环境已启动或验收。Formal 与 Beta 独立，参见 [cluster/formal/README.md](cluster/formal/README.md)、[BETA-SOP.md](BETA-SOP.md)。示例域名为 `game.example.com`，主机/路径用 `<占位符>`；实际管理配置和发布回执只存私有记录。

## 拓扑与所有权

- 同一 game origin 可解析到多个入口。DNS 只选择物理入口，不分玩家区，不保证严格均分、现有连接迁移或协调高可用；增加入口/DNS 须分别授权。
- 每入口的 `server/cluster/ingress.js` 是私有 WS relay，一条浏览器 `/ws` 承载大厅控制和所属对局；所有入口都能到达同一 coordinator 与全部已登记 game 节点。
- `server/cluster/coordinator.js` 持有一个全局 SessionRegistry、Lobby、好友房、party、queue、offer、唯一房码及分配目录，不创建战斗/试算池，不接收逐帧战斗推流。
- `server/cluster/game-runtime.js` 的每个独立进程持有完整 Match/PlayerState、战斗与试算池；Boss、共享 HP/LP、联防、复活和结算留在同一节点，不跨节点拆战斗。
- 高频 `m.field/b.snap/b.ev/m.damage` 等从所属节点直接到入口，沿用压缩白名单和背压，不绕协调器 MainThread。协调器和 ingress 的 combat/trial 为 0。
- 固定 `cluster-deploy.py` core bundle 为一个 coordinator + 十六个 game，每 game 8 combat + 2 trial；Formal edge bundle 支持每入口 1–8 个 ingress，Beta 保留 1–2 个，配置覆盖全部十六节点。逻辑分组不是匹配分区；这些是模板约束，不是运行数量或容量证明。

不恢复 rolling/drain/多版本更新网关，不引入跨版本内存迁移。运行主机按部署者策略只保留必要镜像、宿主管理/恢复工具、runtime、密钥挂载与守卫；开发 checkout、导出、测试工具、文档和证据留开发/管理环境。必要宿主程序不能误删为开发源码。

## 分配、观战与重连合同

1. 协调器校验完整队伍、确认票、房间规则、原好友房、装备、观战权限、期限与配额；提交前保留原房，不改变同版本应用规则。
2. 按已核验节点 generation、build/protocol 和负载准备完整对局；每个真人用上下文绑定的短期票据建立游戏通道，准备阶段不执行游戏意图。
3. 所有真人通道绑定后节点启动，入口缓冲启动帧；协调器再次验证，以一个同步 turn 提交房间与成员。
4. 先发送 `room.state(inMatch)`，再释放启动帧，最后发送 `queue.state(matched)`。真实节点必须启用 `streamMarkers`；`cluster.started` 流屏障防止独立 TCP 通道提前发送 matched。
5. 未获发布确认的对局按有界租约回收；取消、断线、迟到 RPC 和失败提交需幂等补偿。不能丢弃原队伍、FIFO/TTL 或伪造结算来显示成功。
6. 队友在同一节点；外部观战跟随原 owner，不获得 `m.private/m.toast/m.unitStats`。换入口/重连定位原节点，不重新开局。
7. 最终回执联合认证 node identity/generation、actor generation 与 assignment ID；只允许低频 public/个人 result/summary 回协调器，不以终态通道上传任意战斗 snapshot/event。

## 门禁、密钥与公开范围

TLS、共享口令、每次私有请求门禁、可信 Host/Origin、CSRF、登录限速、安全头和 private/no-store 继续有效。多入口同一 profile 使用可互认签名与同源 Cookie；Formal/Beta 使用独立签名 key、Origin、进程/房间/队列，不互相 fallback。

游戏票据/RPC 使用独立节点密钥，不能借用 auth signing key/verifier。秘密只在受保护 runtime/secret mount，不进入源码、镜像层、配置样例、日志、URL query、Cookie 或证据。玩家不得选择任意 IP/URL/上游；目标只来自受审查固定配置。票据绑定 session/room/assignment/node/role/build/protocol，严格 TTL 和有界 clock skew，不信任客户端时间。

保留数量准入 `0=不限` 与各玩法本身的容量规则，以及浏览器 64KiB 入站、每 socket 40/s、heavy 重发 2/s burst6、1MiB snapshot 软丢/16MiB 慢连接断开、RPC/分配期限和执行背压；“不限”不关闭协议防护。普通控制 RPC 请求及所有 RPC 回复仍为 64KiB。仅大于 64KiB 的开局 `prepare` 使用固定私有 `/_cluster/rpc/prepare`，请求上限 2MiB；HMAC 绑定该精确路径与正文，接收端先认证后解析且该路径只允许 `prepare`。完整配置仍逐字段校验、一次准备，超过总预算在任何分配、票据或 actor 创建前拒绝；不删减玩家配置、不新增暂存分片或放宽 WS/其他操作。小开局请求保留原 RPC 路径与签名合同，新大开局路径须协调器和 game 同版配套发布。所有入口提供匹配固定源码的私有 JS/CSS/data；公开素材仅限已验证 immutable 清单和受审查源站 profile，不因扩容公开业务代码、内部 status/RPC 或 game 监听。

公网 health 仅允许精确根路径 GET/HEAD `/healthz` 匿名代理现有内部 status 的固定 HTTP 目标，不转发 Cookie/Authorization、正文或 query，不为别名或业务/API/WS/presence 放宽门禁，也不加 CORS `*`。原生 rich JSON 是非秘密诊断，原样保留正文和 HTTP 状态，不裁字段或缩减 coordinator 的 native schema；HEAD 无正文，其他方法 405。保持 no-store 和既有 Origin 防护；代理 connect/send/read 超时为 1/3/3 秒，不重试，上游不可达/超时不能假报 200。coordinator 200 不保证任何 game 可分配，不新增公开请求触发的节点 RPC/准入/分配。native ingress HTTP404、game 认证状态和宿主逐角色准入保持原合同；源码模板与实际固定 HTTP upstream 必须配对，生产安装/reload 另行授权。

## 固定源码、资源与镜像

`data/local-assets.json` 是 ignored 的必需生成索引，不能仅用 tracked 文件导出；HTTP200 空 `groups` 的程序化棋盘 fallback 不算真实纹理成功。

`tools/cluster-source-export.py` 给出完整真实 commit、与 blob 一致的 checkout 和不存在的新输出目录。源码和 `cluster/Dockerfile.cluster` 逐 Git blob 校验；`tools/cluster-generated-assets.py` 单独验证索引 schema/计数、atlas/mesh 与普通非空引用，写入 resource manifest 的 `generated-renderer-data` 项，不把索引或美术提交为 Git blob。

```sh
python3 -I deploy/stardust/tools/cluster-source-export.py \
  --source "$REPO" --revision "$COMMIT" --out "$NEW_CONTEXT"
```

生成的 `identity.json`、`source-manifest.json`、`resource-manifest.json` 与 `Dockerfile` 是构建输入。离线构建绑定 `SOURCE_REVISION`、`SOURCE_KIND=commit`、`SOURCE_MANIFEST_SHA256`、`RESOURCE_MANIFEST_SHA256` 和 `APP_VERSION`，使用固定基础镜像、无 pull/网络。源码摘要、generated resource 摘要、真实 store image ID/RootFS/labels 分开核对；挂工作树的测试基础镜像不是候选镜像。依赖/同字节素材复用仍验证 lock/manifest/bytes，不覆盖 immutable 文件或因 commit 改变盲目重传。

私有码、resolver、公开多源 pin/alias/fallback 与 game 成套，遵循 [UPDATE-SOP.md](UPDATE-SOP.md)。工具的固定 profile/Origin/路径与冻结输入以版本化源码和实际摘要绑定，不把历史 hash 或 `game.example.com` 替换当通用配置。

## 受保护 bundle 与双 ingress

`tools/cluster-deploy.py` 只生成新受保护 Compose/runtime/keys/host policy，不 SSH、Docker 或激活。输出在仓库外的允许 profile 路径，父目录受保护，拒绝链接、覆盖与跨 profile 路径；generated keys 不能进入 Git。`--profile` 明确 `formal` 或 `beta`，`--role` 为 `core` 或 `edge`，`--entry` 为 1–4。

edge 默认 1 保留单实例合同。Formal 显式 `--ingress-instances 2..8` 生成 `ingress`、`ingress-02` 至批准数量的目标；Beta 仍只接受 1 或 2，core 的 ingress 参数仍固定为 1。每目标有独立 runtime、容器 IP/loopback 端口、CID、process generation、priority 和租约，不能用 sibling 健康替代。扩展实例保持相同的 coordinator 与全部十六节点路由。

[cluster/DUAL-INGRESS.md](cluster/DUAL-INGRESS.md) 规定 WS-only 代理副本、逐目标维护与 CLOSED guard 迁移。只改实际活动 vhost 的 WS upstream，新握手选择批准的全部 target，已有 WS 不迁移；HTTP/auth/private/data/material 不改，不以升级前 retry 绕过 401/403。目录 bind 与单文件 bind 分别按身份/CAS处理，单文件保持 inode；采用实际启动配置检查及正常 reload，不新建第二公共代理。

## 宿主准入与 fail-closed 租约

1. 在角色启动前建立本 profile 的 CLOSED 护栏。Docker 发布涉及 DNAT/FORWARD，绑定 WG 地址或 INPUT 规则不等于隔离；同时约束容器 IP/端口、conntrack 原目的 WG IP/发布端口、可信 WG iface/peer `/32` 和同连接反向回复。
2. `tools/cluster-host-manager.py` 按固定 policy 验证完整 CID、immutable image/source kind/build/manifest、Compose/runtime SHA、安全设置、唯一网络/固定 IP、映射和实际进程 generation。角色健康不同：coordinator 控制健康、game 认证状态、ingress HTTP404/private-no-store 与合法 Origin WS upgrade；不套旧单体 GET health 或 Docker healthy。
3. 仅真实 Node MainThread `nice=-20`，普通 `SCHED_OTHER` + reset-on-fork；combat/trial/V8/libuv/辅助线程0。核对每 game 8+2，coordinator/ingress 为0；不 nice 整个进程、不加容器 CAP_SYS_NICE/CPU/内存 hard cap，保留 PIDs/read-only/cap-drop/no-new-privileges。
4. 全部条件成立才逐目标原子开放精确租约。CID/generation 不是 nft 原生字段，由 manager 认证后生成精确规则；重新监听同端口不恢复旧 owner。重建先撤旧租约，真正启动使用新的不可复用 generation。
5. 多实例 `guard_schema:2` 持久化精确 transaction intent，绑定 policy 与 exact before/intended-after/safe rollback；Formal 3–8 实例的本地守卫日志上限为 256KiB，容纳双份租约账本及原 nft 快照，写入前拒绝超界；其余 policy/runtime 文件仍为 64KiB，本地控制请求仍为 4KiB。`closed_owners/start_intents/unadmitted` 保存 CLOSED 所有权和逐目标准入。未知 drift 拒绝，失败目标不关闭健康 sibling，不自动 adopt 未完整网络/进程身份的容器。
6. 单目标 `revoke/stop/resume` 经过活跃 manager 的 lifetime writer lock 和 root-only 本地 UDS（目录0700、socket0600、SO_PEERCRED uid0），绑定 policy/state SHA、CAS、target、CID/generation/control epoch。`--target` 是批准 service，不是任意名称/CID。主动停用不可被健康轮询或 manager 重启自动重开，显式恢复仍重新准入。
7. 旧单实例 guard 迁移须取得确切 writer lock，证明 CLOSED、空租约、owned table/state、inode/原 SHA，以 CAS 只替换对应对象；不能填新 hash 冒充批准、flush/restore 整表、放开网段、删其他表或绕过外部 WG policy 审批。变更 policy bytes 要相应新批准绑定。
8. 保持关闭护栏→WG→manager 的启动依赖，见 [WG-BOOT-RECOVERY.md](WG-BOOT-RECOVERY.md)。不得修改全局路由/CNI/KUBE/Calico/LXD 等其他网络。显式停/restart 被 `Requires` 依赖的 WG recovery 会连带停 manager/game，不能用于游戏更新；managed 角色保留 `restart=no`，不让 Docker 早于护栏恢复。

应用 append-only 路由能力不等于宿主固定 profile 可随意扩展。更改 runtime SHA、节点/入口或 HUP 前必须准备所有对应路由与守卫批准材料；所有 ingress 先有路由，才启用新 compute。材料存在、enable unit 或隔离启动检查不代表真实角色、公网切换或整机重启恢复通过。

## 发布、故障与回退

先完成固定候选和隔离验收，取得具体环境/组件的部署授权与内存状态丢失确认，再接入口流量；Beta 完成不自动切 Formal，不设定时上线。记录阶段真实结果，控制器中断先读状态，不重放已消费脚本。

**协调状态仍在单个 coordinator 内存，未提供持久化/协调 HA。** 重启可能失去身份、队列、房间索引与分配；game 重启丢失所属对局。多入口只能为仍存活 owner 提供其他连接路径，不是内存容灾，不承诺容量线性增长或增加共享链路带宽。

回退先核对影响和授权，按现用配置 CAS/合并恢复相互匹配的 game、入口 privatecode/data、renderer resources、素材/pin/resolver/profile；精确撤本次 owned 租约和文件，保留其他环境、共享 WG/服务、密钥、镜像、旧素材与私有证据。镜像回滚不能恢复丢失内存局，不能全局 prune/flush。

## 验证和记录口径

单模块/mock、原生 HTTP/WS FixtureMatch、独立真实 Node/Match/Worker、浏览器画面、实体设备与完整 profile 规模分别记录，不互相代替。Docker 元数据注入不算真实镜像身份，手机模拟不算实体手机；性能比较须同负载/口径的隔离对照，不生产压测、Inspector、heapdump 或注入 busy。

真实通过、失败、skip、阶段回执和具体坐标保存在 ignored `.claude/releases/` 或仓库外私有归档，见 [releases/README.md](releases/README.md)。公开指南不保存活动数量、故障日志、历史授权或实际部署 hash，源码记录提交也不改变运行身份。
