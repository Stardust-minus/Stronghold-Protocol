# 统一匹配与多入口集群部署

## 杭州prod-only运维约束（2026-10-07追加）

杭州ark计算只运行正式profile（1协调器+16节点）；Beta17容器与旧Beta已停止，旧/Beta管理器和恢复单元禁用，正式代次/租约/健康不变。Beta当前不可用，不按下面历史验收表或旧controller自动拉起。

杭州不得保留开发checkout、源码导出、测试副本或发布文档；已核对并异机保全后清理16个非运行必需树。正式镜像内的程序、6个配套宿主管理/恢复程序、运行配置与密钥挂载是必要依赖，不能删除；停用配置/闭锁接口和回滚Docker镜像保留，其他主机服务不碰。后续文档和跟进记录只留管理机/Git，不回写杭州。当前跟进状态见[prod-only记录](releases/v014-core-prod-only-20261007-5b63d51.json)。

## 上线时双profile验收基线（2026-10-07，历史快照）

正式与修复版Beta均已验收运行`5b63d51dddeba07292eb9891beee776850c1bb75`；完整身份与结果见[发布记录](releases/v014-cluster-formal-20261007-5b63d51.json)。两个profile各1协调器/16个8+2节点/3活跃入口（`.78/.73/.92`），40个角色实机Main-only-20/reset/其它线程0、初始CID/精确租约核验通过。`.75`0角色/闭锁，不加入DNS。

公开正式入口已切换。旧f3/be27由用户明确授权直接停用；旧core管理器inactive/disabled、旧Formal-only租约关闭，不能仅reload留下旧WSS大厅。旧容器/镜像/配套私有码与素材保留，旧WG及legacyBeta不动。正式三站点复用现有代理、只正常reload，独立profile状态和门禁签名保持隔离。

主助手真实五客户端三入口匹配/买卡部署/纹理/首战→第二轮/观战重连、全部音频解码及最终零异常通过；正式/Beta各312私有码TLS矩阵及跨物理入口身份恢复通过。音频CDN非audio MIME触发的主动cancel只按实际调用和精确请求链记录，不笼统忽略错误或绕TLS。历史失败记录保留。

用户已自行添加正式`.73/.92`A，公共DoH返回三条A/TTL600，无`.75`；无需重启协调器/节点。旧DNS缓存和长连接不会立即迁移，DNS不严格均分，也不增加同一profile的16节点数或内存HA。未来添加其它入口须重新验收同origin/TLS/gate/privatecode/素材、全16路由及精确租约，不能只买机器加A。

以下规范包含早期候选准备说明，以本条实际基线和最新授权覆盖历史“未部署”状态；已完成一次性控制器不得重放。


> **2026-10-07本批：用户已明确授权全部修复、验收完成后推送并部署生产；DNS不自动修改。** 四台入口（含原`.78`）的目标规模为杭州16个8+2游戏节点/一个协调器，杭州上行用户确认2Gbps；当前`.75`因UDP链路故障保持禁用，不能称四入口均已就绪。Formal与Beta使用独立固定profile，详[cluster/formal/README.md](cluster/formal/README.md)。材料存在或WG恢复安装不代表角色启动、公网切换、材质或玩法验收完成。现有活动版本以实际release与实时组件身份为准，不把未提交功能分支冒称成当前HEAD的已发布镜像；旧正式/Beta单体与旧WG/recovery不能套用或顺带重启。

## 拓扑与所有权

- 同一正式域名可解析到多个具有独立出口带宽的入口。DNS 只分配入口，不决定玩家的游戏节点，也不保证连接数或流量严格均衡。
- 每个入口后面是私有 `server/cluster/ingress.js` WS relay；一条浏览器 `/ws` 同时承载大厅控制与所属对局。所有入口都必须能到达协调器和已登记的游戏节点。
- 协调器 `server/cluster/coordinator.js` 保留一个全局 SessionRegistry、Lobby、好友房、party、queue、offer、唯一房码和分配目录；不创建本地战斗/试算池，不接收逐帧战斗推流。
- 游戏节点 `server/cluster/game-runtime.js` 拥有独立进程、战斗/试算池、完整 Match 与 PlayerState。本批目标16个节点、每节点8战斗+2试算，保持服务器权威计算；整个联防、共享Boss、复活和结算留在同一节点，不跨节点拆战斗。四入口均路由到全部16节点，逻辑每入口4节点分组不产生匹配分区。
- 高频 `m.field/b.snap/b.ev/m.damage` 等直接从游戏节点到对应入口；入口应用既有压缩白名单和背压，不让所有战斗帧绕一个协调 MainThread。
- 这不是恢复旧 rolling/drain/多版本更新网关。游戏进程仍保持内存状态，当前设计不承诺跨版本或跨进程迁移正在进行的对局。

## 分配、观战和重连

1. 协调器先验证完整队伍、确认票、房间实验性设置、原好友房、装备、观战者、期限和可选配额，保留原房直到提交。本批取消开局复活投票，复活与禁用共享卡池由房间实验性面板配置，单人匹配跟随房间；具体新规则以同版本应用代码/验收为准。
2. 按当前已核验节点代次、版本和负载准备一个完整对局；各真人用上下文绑定的短期票据先建立游戏通道，准备阶段不执行游戏意图。
3. 所有真人通道绑定后，节点启动但入口缓冲启动帧；协调器再次验证，单个同步turn提交房间与成员。
4. 先发 `room.state(inMatch)`，再放行节点启动帧，最后 `queue.state(matched)`。内部 `cluster.started` 流屏障避免独立TCP通道把matched提前送到启动帧之前；生产游戏节点必须启用 `streamMarkers`。
5. 未获得发布确认的节点对局按有界租约回收。取消、断线、迟到RPC、失败提交均有幂等补偿；不得为了显示成功丢弃原队伍、票据FIFO/TTL或发一个假的结算。
6. 队友始终在同一对局节点，原 `g.watch` 权限保留。外部观战者跟随房间索引，不获得 `m.private/m.toast/m.unitStats`；换入口、重连仍定位原owner，不重新开局。
7. 一份最终回执由节点身份、节点代次、actor代次和分配ID共同认证；仅低频最终public/个人result/summary分片回协调器，供原大厅和离线个人回放。不能使用终态通道上传任意战斗snapshot/event。

## 安全边界

- 入口relay、协调器和游戏监听都不是独立公共网站。外部仍经过既有TLS、共享口令、每次private请求门禁、固定Origin与安全头；公网内部health/RPC/game端点保持不可达。
- 多入口必须采用一致的认证验证方案和同源Cookie语义，不得各自生成互不识别的认证签名key。认证/CSRF/登录限流与Host/Origin检查不放松。
- 游戏入服和私有控制RPC使用独立的节点密钥，不借用认证签名key/口令verifier。密钥放宿主受保护runtime文件或secret mount，不进入源码、镜像层、配置样例、日志、证据、URL query或Cookie。
- 节点目标只来自部署者固定配置；玩家不能通过消息选择任意IP/URL/上游。票据绑定session、room、assignment、node、role、build、protocol，严格有效期；微小跨主机钟差允许值有上界，不信任客户端时间。
- 数量准入默认仍为0=不限，但四人玩法、单身份绑定、64KiB入站、每socket40/s、重发heavy2/s burst6、1MiB snapshot软丢/16MiB慢连接断开、RPC/分配期限和执行背压继续保留。
- 所有入口提供同一固定源码的私有JS/CSS和data，仍private/no-store；公开素材仍为已验证immutable清单及现有ModelScope60/OpenI40路由。不得因扩容把业务代码或data转成公开素材。

## 固定源码与生成资源身份

`data/local-assets.json`是ignored的生成素材索引，但属于运行时必需资源。仅导出`git ls-files --exclude-standard`会漏掉它；服务端HTTP200返回空`groups`仍会触发程序化棋盘fallback，不能作为真实纹理验收成功。

候选导出必须使用`tools/cluster-source-export.py`，给出真实完整commit、当前已核对checkout和不存在的新输出目录。导出器逐Git blob检查业务源码与Dockerfile；索引单独经`cluster-generated-assets.py`验证schema、精确计数、必需atlas/mesh和所有引用的普通非空资源，再写入resource manifest的`generated-renderer-data`项。不得提交索引/美术正文或把它冒称Git blob。

```sh
python3 -I deploy/stardust/tools/cluster-source-export.py \
  --source /root/projects/Stronghold-Protocol --revision "$COMMIT" --out "$NEW_CONTEXT"
```

离线镜像构建须同时给出`SOURCE_REVISION`、`SOURCE_KIND=commit`、`SOURCE_MANIFEST_SHA256`、`RESOURCE_MANIFEST_SHA256`和`APP_VERSION`。固定code commit/source digest、generated资源digest和各Docker store实际immutable image ID分别记录；源码测试、镜像逐文件检查、真实2D atlas/3D纹理与mesh渲染缺一不可。现用F3公共provider素材只有证明同字节后才可复用，不因代码commit变化重传或覆盖immutable资源。

## 宿主安装前还必须完成

- 固定并核对候选源码、image ID、data/静态清单、入口私有码及回滚资料；不把基础Node24镜像的旧游戏revision冒称为挂载测试的新源码。
- 本批新增`cluster-deploy.py`生成独立Compose/protected runtime与root policy，`cluster-host-manager.py`负责新namespace精确生命周期/租约/角色health。**旧core profile要求单体游戏12+2和GET health，不能直接套到worker0协调器或私有RPC游戏端点。** 实际安装、四机TLS/门禁/素材和开机恢复仍需主助手完成/记录，不能以材料存在冒称实机已通过。
- 只Main nice=-20、普通SCHED_OTHER/reset-on-fork，其他线程0；不nice整个Node、不授容器CAP_SYS_NICE、不加CPU/内存hardcap，保留PIDs/read-only/no-new-privileges等保护。
- 新入口加入WG时只精确peer/32、指定端口/容器/image/generation租约；启动核验前闭锁。不得flush/restore整张nft表，也不修改CNI/KUBE/Calico/LXD、默认路由或现有WG恢复服务。
- 游戏节点每次真正进程启动需要新的不可复用generation；重建之后旧内存对局视为失去owner，不能把同端口重新监听等同恢复旧对局。
- 先完成隔离本地浏览器与完整回归，再按本批明确授权只部署Beta及准备四入口。新节点/入口接正式流量、维护影响和DNS改变仍按实际许可执行，不设置05:00自动切换。宿主runtime SHA固定，不能在未准备对应新守卫批准材料时直接改文件HUP；应用append-only能力与宿主固定16profile分别说明。

## 故障与回退限制

多个入口可以分散100Mbps出口压力，也允许经另一入口重连仍存活的游戏节点；并不增加同一个共享上游管道的带宽，也不保证容量按机器数线性增长。

**当前协调状态仍在一个协调进程的内存中，持久化/协调高可用尚未实现。** 协调器重启可能失去全局身份、队列、房间索引和分配记录；入口冗余不能被宣传成对局内存容灾。节点本身重启也丢失其对局。首次上线需要明确告知维护/刷新与状态丢失边界，不能承诺无损切换。

回退时将入口/privatecode/data/游戏和配套素材恢复到相互匹配的固定版本，并保留新旧目录、keys、images和证据；回退源码不能找回已经丢失的内存局。原正式与Beta、其他网站、数据库和证书不因候选试验被清理。

## 验收证据口径

- 单模块/受控mock用于分配竞争、权限和补偿，不代表真实玩法/移动端/生产容量。
- 本地原生HTTP/WS多端点验证使用真实Registry/Lobby/Matchmaking，但其中的测试Match必须明确标识。
- 独立Node24进程、真实Match/Worker和Chrome验证才证明实际渲染与传输接入；小型2+1池不代表本批16×8+2规模或千人容量，手机模拟不代表实体手机。新root工具的8+2 native priority与fresh-netns真实TCP/DNAT正/负验收口径详cluster/README，注入Docker元数据不冒称实际镜像身份验证。
- 任何性能/带宽结论需要相同工作负载、相同口径的隔离对照；不得生产压测、Inspector、heapdump或注入busy。
