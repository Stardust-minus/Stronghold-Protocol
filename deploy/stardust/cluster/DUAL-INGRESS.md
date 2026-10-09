# 每入口两个独立 ingress

## 实际正式状态（2026-10-09）

已部署固定游戏／宿主工具 commit `24ff0dba30833426ec6ec02b010a580f89c4d3e1`，client-build `9c1fd471887b`。四入口各两个 ingress／25原生角色、16×8+2、Main-only-20/reset/other0、全部精确租约和schema2 edgeguard已验收，四OPEN。原入口secondary初次Docker35402绑定失败造成未启动、未附着网络的created容器；正常primary保持，精确清理撤权CID后manager scoped resume恢复第二个，没有再重启健康角色。详细失败及实际身份以 [发布记录](../releases/next-dual-ingress-20261009-24ff0dba.json) 为准；下方本地证据不是新的重测／重新激活许可。

## 范围

目标为四台物理入口各两个独立 Node ingress，共八个；保持一个 coordinator、十六个游戏节点及统一大厅／匹配池。不是 worker_threads 逐帧中转，不增加入口的 100Mbps 出口，不需要浏览器 `ingressId` 或 sticky。

2026-10-09 用户已批准验收后直接切换正式服，并另选当前功能分支本地提交、离线镜像及重建限时直连。不推送或合入 master，不改 DNS、PRTS 登录页／口令、停用 Beta、WG 恢复依赖或其他服务。切换会结束现有内存房间与对局；回滚镜像不能恢复它们。

本文描述候选与运维合同，不证明当前线上已经八个 ingress。生产结果以本批实际发布记录为准。

## 实例与部署

生成器 `cluster-deploy.py` 默认 `ingress_instances=1`／CLI 不加参数时保留原单实例格式；edge 明确选择 `--ingress-instances 2` 才生成双实例。core 扩展为二被拒绝，仍是十七个计算／协调角色。

| profile | service／target | 容器 IP | loopback 端口 |
|---|---|---|---|
| Formal | ingress | 172.30.246.2 | 35401 |
| Formal | ingress-02 | 172.30.246.3 | 35402 |
| Beta 示例 | ingress | 172.30.243.2 | 35301 |
| Beta 示例 | ingress-02 | 172.30.243.3 | 35302 |

每个实例有独立 runtime、容器、进程、端口映射、进程代次和精确租约。两份配置指向同一协调器，包含全部十六节点；不能以另一个实例的健康或优先级替代本实例检查。Beta 示例支持不意味着启动已停用的 Beta。

沿用 Main-only nice=-20、SCHED_OTHER/reset-on-fork、其他线程0；不 nice 整个 Node，不授容器 CAP_SYS_NICE，不新增 CPU／内存 hard cap。入口的健康合同是 HTTP404/private-no-store 加合法 Origin 的 WS upgrade，不能套用游戏的 HTTP200/health JSON。

## WS-only Nginx 准备

`deploy/stardust/tools/prepare-dual-ingress-proxy.mjs` 只生成一个新目录中的 vhost 副本与 `proxy-preparation.json`，不安装、不修改输入、不 reload。

```sh
node deploy/stardust/tools/prepare-dual-ingress-proxy.mjs \
  --source REVIEWED_ACTIVE_VHOST.conf --profile formal --out NEW_DIRECTORY
```

必须输入实际活动 vhost 的已审查副本，而非拿仓库早期单机模板覆盖线上。工具只将根 `/ws` 和已有精确 legacy WS location 的 named upstream 改为双 loopback `least_conn`，保留原 HTTP／auth／privatecode／data／material／Origin／可信转发头与超时字节。未知、重复、禁用门禁、retry 歧义及已准备输入拒绝，不 silently rewrite。

只分新 WS 握手；已有 WS 不迁移。`proxy_next_upstream error timeout`／tries2 只处理升级前的连接错误；不把 Origin403／门禁401 变成重试绕过。Nginx least_conn 不承诺所有 worker 全局严格均分。原单文件 bind 的 vhost 需保留 inode、备份与 CAS 写入，采用实际启动配置语法检查及正常 reload；HTTP 和密码门禁不接到 ingress 的404监听上。

## 管理器与单实例维护

双 edge `serve` 保持原 lifetime writer lock。root-only 本地 Unix 控制位于 `/run/<project>.control/manager.sock`，父目录0700、socket0600，SO_PEERCRED 要求 uid0；不是公共 HTTP、浏览器协议或新的私有 TCP 管理端口。

```sh
python3 -I INSTALLED_TOOLS/cluster-host-manager.py \
  --profile formal --config APPROVED_HOST_POLICY.json --action revoke --target ingress-02
python3 -I INSTALLED_TOOLS/cluster-host-manager.py \
  --profile formal --config APPROVED_HOST_POLICY.json --action stop --target ingress-02
python3 -I INSTALLED_TOOLS/cluster-host-manager.py \
  --profile formal --config APPROVED_HOST_POLICY.json --action resume --target ingress-02
```

请求有4KiB／绝对2s接收界限，严格字段与 JSON，绑定精确 policy SHA、guard-state SHA/CAS、target、CID、进程代次和单调 control epoch。`revoke` 保留进程但撤本租约；`stop` 撤权后停确切 CID；健康轮询与管理器重启不能自动重开／重启主动停止实例。显式恢复需先核对容器、源码／runtime、代次、Main-only策略及健康，再开放仅自己的租约。另一实例的有效租约不得被一并清空。

**三条异常路径已修复并完成本地验收（2026-10-09）：** dual-only `guard_schema:2` 先持久化精确 nft transaction intent 再 apply；仅接受绑定 policy 的 exact before／intended-after／safe rollback，不放宽未知 drift。`closed_owners`／`start_intents`／`unadmitted` 在生命周期和 admission 前记录 CLOSED ownership，使失败恢复可显式 retry；双实例逐目标 admission，失败目标不关闭健康 sibling。fresh224项 Python（219通过／5既有opt-in跳过）、4实际Node24 native、52隔离真实kernel检查通过；限定独立复核确认原三条问题已关闭，无确认剩余问题。此前204／4／44数字仅为旧源码证据。当前完整回归608文件／6720项、6696通过／24条件跳过／0失败，官方283golden一致；这些本地结果不替代正式Docker/systemd/WG和全部25角色接受。

## 旧单实例 CLOSED guard 迁移

旧单实例和新双实例的 host-policy bytes／允许 IP 范围不同，不能往旧 guard JSON 填一条 `policy_sha256` 冒充迁移，也不能自动更新或关闭外部 WG approval 检查。

1. 在明确维护中按实际 unit／PID／policy／CID 识别并正常停旧管理器，取得确切 project writer lock；证明原批准 policy、owned table、guard state 及 inode 身份，`Guard(old).check({})` 且 lease 链确实为空。
2. 保全原 metadata，再由本批已批准的新控制器进行身份／inode／SHA CAS，只替换这个 CLOSED owned edge table 与对应 guard state。不全表 flush、restore、删其他 table 或改 WG interface／peer／key／route。
3. 安装同版已验证 policy／Compose／runtime。若现有外部审批绑定 host-policy bytes，双实例必然需要显式批准的新 SHA；若只绑定未变 WG 输入，则保留其原绑定。不能让改变后的 bytes 继续冒称原 hash。
4. 新 `guard` 创建同时保护 `.2/.3` 的 CLOSED fence，绑定精确 policy。随后按已批准的 handoff／serve 顺序逐目标准入，全部 native generation／priority／lease 验证后才接新 WS。
5. 不停止或重启被 manager `Requires` 依赖的 WG recovery。正常退出只删除本管理器验证的 socket inode；任何 stale socket 先证明 owner inactive 和 inode 身份，再精确处理，不能通用自动 unlink。

## 本地证据与性能边界

证据目录 `.cache/stardust/dual-ingress-preparation-20261009-jgbFMp/`。

- native transport 9文件102项通过，两个独立 ingress＋真实协调器／认证节点传输；Match明确fixture，覆盖同池／跨入口身份归属／旧close隔离／raw字节／private0／SIGTERM与SIGKILL，不是战斗 Worker证明。
- Main真实 Worker/browser R0通过：独立coordinator/game/两个ingress四Node进程、1战斗Worker、Nginx＋dummy本地gate、三Chrome；完整／旧／错误预设、跨浏览器恢复、战中同identity刷新和强制结束一个入口后的同owner恢复、观战private0。Main实际查看画面中的两个starter actors与触屏3×44px/nooverflow；软件WebGL／手机模拟／受控波次不等于实体设备或自然整局平衡。
- 新代理unit4＋actual OpenResty R1共5通过；echo targets证明代理／门禁／Origin／旧healthy WS／新握手fallback，不把echo当完整game proof。R0 fixture缺cached Lua path的失败保留。
- quiet ABBA benchmark R1：每case96连接／24房间／10Hz／200ticks／19200帧、同372431232字节payload、同PMD，四case closed／零丢失／零gap／零duplicate。所有role实际继承NI+5相同，非正式Main-20；生成Match为TransportFixture，非真实战斗／WAN／TLS／Nginx。最忙进程CPU中位数20.7251→15.1178%onecore，Main5.6024→4.2446%，sumCPU20.7251→29.7889%、sumRSS217088000→366757888B、P95延迟6→5ms。资源开销与单进程减压同时报告，不能称CPU减半／容量翻倍／100Mbps变200Mbps。
- 保存每实例、max、sum、owned组CPU及含其他进程的全hostCPU、ELU、10ms分辨率delay、RSS／FD、官方bufferedAmount和注明版本的sender/socket subgauge、TCP与payload字节。闭包里的启动／control队列不可直接采，记 unavailable，不造sendQ或把subgauge重复相加。
- Exploratory R0原件保留；错误NI0 metadata、两样本min误称median及短native测试重叠已在独立note标明，不作为最终比较。

所有后续源码、镜像、私有码、源站配置和正式25角色验证仍需配套记录；本地proof不等于正式已切换。
