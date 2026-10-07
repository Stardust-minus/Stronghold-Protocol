# Beta 集群部署角色

显式独立Formal profile及安装/schema合同见[formal/README.md](formal/README.md)。新工具默认Beta、旧policy/runtime/无profile字段WG metadata仍兼容；共享`cluster-profile.py`须与工具同目录投放。不得因此替换在线Beta工具或宣称Formal已部署。生成资源data与Git代码库存必须分别验证。

本目录是2026-10-07新角色部署材料，**材料存在不等于已安装或已接流量**。本批用户已授权配置三台新嘉兴机器和更新Beta；正式服、DNS、旧WG/recovery、旧core/Beta单体管理器与Git提交仍不因这些文件自动变化。

## 固定拓扑

- 四台嘉兴均为可用入口：原`.78`对应入口01，新增`.75/.73/.92`对应02/03/04，8C16G、独立100Mbps；不是一台工作、三台备用。
- 一个杭州协调器、16个杭州完整对战进程，每个**8 combat+2 trial**。协调器和入口不创建战斗/试算Worker。
- 每入口逻辑部署分组4个游戏节点，但**每个入口都持有全部16个节点路由**。玩家共用一个大厅/好友房/party/匹配池；同局、联防、Boss、观战固定一个owner，不按入口分区。
- 杭州上行用户确认2Gbps；四入口标称400Mbps并非四倍容量证明。内层WS不压缩，WG回程原始帧、外层压缩CPU、DNS/长连接分布都必须分别衡量。
- 新接口`ark-wg-cluster`：杭州`10.253.78.2/32`，四入口`.11/.12/.13/.14/32`。只有精确peer/32和对应路由，不改旧`ark-wg-test`、默认路由、CNI/KUBE/Calico/LXD。

| 角色 | 宿主映射 | 容器内监听 | 精确容器IP |
|---|---|---|---|
| coordinator | `127.0.0.1:35300`、`10.253.78.2:35300` | 3000 | `172.30.242.2` |
| terminal RPC | 仅`127.0.0.1:35310`；同bridge游戏直连3001 | 3001 | 同coordinator |
| game01..16 | loopback及WG`35311..35326` | 3000 | `172.30.242.11..26` |
| 每台ingress | 仅`127.0.0.1:35301` | 3000 | 各宿主独立`172.30.243.2` |

这里的`0.0.0.0`只用于容器内监听，不允许在宿主直接启动这些角色裸露原始端口。公开流量仍走TLS、同源Origin、口令门禁、每次private请求校验、private/no-store及匹配素材；ingress HTTP始终404，受保护HTTP/privatecode/data由本地供给或coordinator供给。共用认证验证key和Cookie语义需要主助手实机独立核验，不能在四台入口各自产生互斥登录凭证。

## 不冒称Git版本的固定源码

`Dockerfile.cluster`只使用已验证且本地存在的Node24 digest；离线构建必须`--network=none --pull=false`，不在国内节点临时拉依赖/素材。游戏/私有码/data/vendor/静态清单必须来自同一已经验收的app导出。

- `SOURCE_KIND=commit`：`SOURCE_REVISION`为真实固定commit；还记录独立完整source manifest SHA256。
- `SOURCE_KIND=tree`：用于用户未授权commit但已授权Beta的固定未提交快照；`SOURCE_REVISION=SOURCE_MANIFEST_SHA256[:40]`。这只是明确标注的内容身份，**不是Git commit**，不能把当前HEAD4182b37写成包含cluster改动。
- 镜像必须携带OCI source/revision以及`cn.stardust.cluster.source-kind`和`cn.stardust.cluster.manifest-sha256`；root管理器固定实际`sha256:imageID`，不接受可移动tag。
- app导出/manifest校验由主发布流程完成；生成器不能替调用者证明其传入的digest确实覆盖app内容。

## 生成全新受保护材料

主助手先把三个host工具按固定源摘要安装为root-owned、不可group/world写的文件：`cluster-deploy.py`、`cluster-host-manager.py`和其复用的`main-thread-priority.py`。旧单体工具安装路径/profile不替换。

```sh
# 父目录须已经是root-owned、不可group/world写；OUT必须是不存在的新目录。
python3 -I /opt/ark-cluster-beta/tools/cluster-deploy.py \
  --role core --out "$NEW_CORE_BUNDLE" --image-id "$ACTUAL_IMAGE_ID" \
  --source-kind "$SOURCE_KIND" --build "$FIXED_BUILD" \
  --manifest-sha256 "$SOURCE_MANIFEST_SHA256"

# 在每个对应入口分别生成；entry为1..4，不是“每台四节点”路由限制。
python3 -I /opt/ark-cluster-beta/tools/cluster-deploy.py \
  --role edge --entry "$ENTRY_NUMBER" --out "$NEW_EDGE_BUNDLE" \
  --image-id "$ACTUAL_IMAGE_ID" --source-kind "$SOURCE_KIND" \
  --build "$FIXED_BUILD" --manifest-sha256 "$SOURCE_MANIFEST_SHA256"
```

生成`compose.json`（JSON是Compose支持的YAML子集）、每角色`runtime/runtime.json`、root-only`host-policy.json`和非激活摘要。核心16个独立32-byte节点key只生成一次；每game只挂自己的key，coordinator挂全部节点key，ingress不持有节点key。真实key不进入argv/env/JSON正文/镜像/日志。容器只读文件采用root:1000、0440，父目录0750；policy/Compose0600。不存在的目录可创建，已有目录**包括空目录**都不覆盖。

全部角色有init、UID/GID1000、read-only、cap-drop ALL、no-new-privileges、PIDs128、受限tmpfs与轮转日志；**没有CPU/内存hardcap、CAP_SYS_NICE或整个Node的nice包装**。Docker restart固定no，由新root生命周期闭锁后启动。

## 实际安装/启动顺序

1. 保存正式/Beta原有CID、source/image、StartedAt、配置哈希及回滚材料。仅处理本批新namespace、接口和文件，旧恢复服务不restart。
2. WG创建前先装主助手独立bootstrap表`ak_cluster_beta_boot`，早于其他宽泛established规则，只允许指定peer/32的ICMP，其余新接口INPUT/FORWARD全DROP。TLS/auth/privatecode/素材先核验，不接公开Beta流量。
3. 配置新WG接口/精确peer/32与路由。核心主动连四入口公网UDP51838，keepalive25；私钥只在远端受保护文件和程序内存，不能回显。旧宿主可用已验证`/opt/ark-wg-test/bin/wg`，新机`/usr/bin/wg`；新管理器只允许这两个root-protected固定路径。
4. 生成上述bundle，把`host-policy.json`独立复制到`/etc/ark-cluster-beta/host-policy.json`（不通过会变化的symlink选版本）。保留真实bundle路径不改动。
5. 先执行`cluster-host-manager.py --config ... --action guard`：新core表`ak_cluster_beta_core`、新edge表`ak_cluster_beta_edge`闭锁，CAS摘要记录在各自`/run/<project>.guard.json`。只有这两个新表的owned lease RULES按handle原子替换；不flush/restore全表，不改其他表。
6. 已证明新guard闭锁后，主助手按bootstrap实存hash/handle核对，仅删除本批bootstrap拒绝RULES。否则bootstrap继续DROP，即使其他表ACCEPT也不能接流量。
7. 按模板安装独立`ark-cluster-beta-wg.service`依赖及core/edge manager服务。WG启动单元属于主助手实机配置，需要自己具备同一bootstrap-before-interface顺序；模板不会替调用者生成私钥或自动安装WG恢复。
8. manager `--action serve`先闭锁→查新WG→仅启动缺失的本namespace角色/按已核准CID恢复已停止角色→检查actual image/source/config/mount/network/PID/cgroup/startTicks→实际8+2/privatehealth或worker0/relay协议→**先reset-on-fork，再只Main -20**→全代次再核验→最后发布精确WG租约。
9. 四入口均暖机并路由到全部16节点，再核验coordinator全16节点就绪、实际Nginx/TLS/认证/私有码/资源及浏览器。最后只更新Beta vhost配套入口；正常Nginx reload，不重启共享代理/正式game/auth。DNS改变不属于这些命令，也不因服务已启动自动执行。

## 健康与生命周期边界

- game：固定node/build/protocol/publicSlot、streamMarkers以及签名RPC私有`health.combat={status:ready,workers:8,ready:8}`、trial2/2；10个真实WorkerThread，只有Main -20/reset，其他线程0。health不进入浏览器PONG，普通HTTP GET/health404不可套单体healthcheck。
- coordinator：原生GET health显示0 combat/0 trial、maxRooms0；真实WorkerThread数量0。它的browser build与runtime内容身份是不同字段，不冒称相等。
- ingress：GET health404+固定Origin的loopback WS upgrade、0 WorkerThread、固定源/路由/配置/代次；这是relay监听验证，不是TLS、口令或完整公网玩法验收。
- 每5秒检查固定代次；image/bridge的不可变ID元数据缓存，容器/PID/线程、runtime文件、私有health仍重读。不按入口在线人数推断后端CPU。
- 单个节点/入口故障只撤该角色租约，不关闭健康协调器和其他节点。相同进程/节点epoch的pool恢复可恢复原租约；**新PID/StartedAt/node generation绝不自动继承旧活跃租约**，需要显式闭锁启动生命周期。host policy/WG/table整体漂移才关闭本host新集群。
- 停止manager会只撤新WG租约，已完成Main策略保留，新容器暂留供诊断；它不会stop任何正式容器。显式停本批计算用`--action stop`，先闭锁，再按记录的**全部本namespace immutable CID+image/source+StartedAt/restarts**逐个复核停用。代次不符拒绝，不按可复用名字盲停。先停止manager服务释放writer lock再执行stop；guard状态保留owned CID，即使先闭锁或某节点暂时不健康，也不丢停止凭据。
- manager不修改旧core/beta/prod工具、旧WG/recovery、其他站点、数据库或证书，不执行镜像清理。

一个coordinator仍是内存状态、无持久化/HA；game重启丢本节点局，coordinator重启可能丢全局身份/队列/目录。四入口不是内存容灾。首次Beta切换/回滚都不能恢复被重建的内存局。

## 追加与范围

应用CLI保留SIGHUP append-only路由/节点：先核验新game→先全部入口追加路由→最后coordinator允许新局选它，旧局不迁移。本轮root inventory固定16节点，runtime SHA固定；**不能直接HUP修改文件而不同时准备相应守卫批准材料**，否则守卫按漂移撤权。16之外的root inventory/生命周期扩展是下一份显式受控适配，不能声称此固定16profile已经支持任意node增删。

## 本地验证

```sh
python3 -I deploy/stardust/tools/test_cluster_deploy.py
unshare --net python3 -I deploy/stardust/tools/cluster-kernel-check.py --isolated-netns
unshare --net python3 -I deploy/stardust/tools/cluster-traffic-check.py --isolated-netns
CLUSTER_NATIVE_PRIORITY=1 CLUSTER_NODE24=/tmp/n24.95W3Gu/bin/node \
  python3 -I deploy/stardust/tools/test_cluster_native_priority.py
```

2026-10-07：30个Python测试方法通过（含copied-installed-layout生成/载入core与edge、安装路径仍拒绝known checkout、停用全CID预检/代次变化拒绝、多组镜像/角色/配置/资源/绑定/密钥mount拒绝子用例），原单体host工具181项回归也通过；新namespace10项nft编译/闭锁→发布→关闭/CAS/foreign-table保持通过；**8项实际TCP/DNAT**授权成功与closed/wrong-port/direct-IP/wrong-peer/foreign-interface/已established关闭通过；owned真实Node24.14的8+2私有RPC、Main-20/reset、其他线程0通过。Native priority测试的Docker元数据是注入fixture，不把它当实际Compose镜像身份验收；veth/DNAT测试不验证WG加密/实机TLS/auth。

首轮kernel fixture空counter语法失败，已改正确字段；随后发现libnftables1.1.6采用`key:"ip daddr"`、旧Ubuntu1.0用familyip表示，改为有界compile-only兼容选择后仅一次apply，重新跑上述正/负kernel用例通过。没有在宿主网络namespace执行试验，也不因此称四台实机验收完成。

实际安装前主助手发现旧repo路径从`__file__.parents[3]`推导，在`/opt/ark-cluster-beta/tools`会变成`/`并拒绝所有bundle；初始repo内测试漏掉此场景。已改为known `/root/projects/Stronghold-Protocol`始终禁用、另一个checkout只有Gitmarker+精确source-tool路径anchor才识别、绝不把`/`当repo；copied-installed-layout实际生成与载入core/edge、known checkout仍拒绝两项回归通过，应用TREE/image未改变。

Beta固定TREE私有码的独立新工具、104URL实际准备校验与11场景真实NginxHTTP验证见[PRIVATE-CODE.md](PRIVATE-CODE.md)。旧Git-commit严格导出器未修改。

首轮真实core部署17角色均running，但新manager三次失败/rollback、租约一直closed。只读抽查两个新角色确认CID/StartedAt/PID/startTicks稳定，唯一变化是Docker classic每次从map构造`Mounts`数组顺序不同；继承的snapshot比较完整dict，把顺序变化误判为generation变化。实际Main仍0且其余线程0，service BoundingSet包含CAP_SYS_NICE，不能先怪NoNewPrivileges或降低nice要求。已在严格验证所有mount行后只规范化该无序数组，保留每行全部语义字段；新顺序回归通过，真实路径/RO/metadata变化仍拒绝或触发fence。

新增`test_cluster_docker_priority.py`实际启动一个owned localhost冻结Node24镜像/UID1000/init/cgroup/私有8+2角色，在每次inspect强制交替raw Mounts顺序，完整System/Helper/lease路径通过：实际Main-20/SCHED_OTHER|RESET、10个Worker及V8/libuv等其他线程0。container/新bridge核对immutable ID后停用删除，无remote写操作、不影响正式/Beta旧单体；这是单角色实际Docker验证，**不是16个实机角色已经成功部署/已开租约**。运行需opt-in：`CLUSTER_DOCKER_PRIORITY=1 python3 -I deploy/stardust/tools/test_cluster_docker_priority.py`，固定本地镜像通过`CLUSTER_PRIORITY_IMAGE`明确提供。
