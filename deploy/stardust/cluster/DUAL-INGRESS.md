# 每入口两个独立 ingress

本文说明双实例候选及运维合同，不记录具体部署、故障流水或验收状态。实际输入、身份、摘要和检查结果保存在Git外的私有发布记录，见[记录边界](../releases/README.md)。

## 范围

此固定profile支持每物理入口两个独立Node ingress；所有入口仍指向同一个coordinator、十六个游戏节点及统一大厅／匹配池。不是worker_threads逐帧中转，不增加物理出口带宽，不需要浏览器`ingressId`或sticky，也不允许客户端直连原始后端。

准备、验证与切换分别需要授权。切换会结束被重建进程中的内存房间与对局；回滚镜像不能恢复它们。文档、模板与本地检查不能证明公开入口已激活。

## 实例与部署

生成器 `cluster-deploy.py` 默认 `ingress_instances=1`／CLI 不加参数时保留原单实例格式；edge 明确选择 `--ingress-instances 2` 才生成双实例。core 扩展为二被拒绝，仍是十七个计算／协调角色。

下表仅为字段示例，不是可直接执行的profile值；实际绑定由生成器固定，不能用文档占位符绕过policy校验。

| profile | service／target | 容器 IP | loopback 端口 |
|---|---|---|---|
| Formal示例 | ingress | `<FORMAL_INGRESS_IP>` | `<FORMAL_PRIMARY_PORT>` |
| Formal示例 | ingress-02 | `<FORMAL_SECONDARY_IP>` | `<FORMAL_SECONDARY_PORT>` |
| Beta示例 | ingress | `<BETA_INGRESS_IP>` | `<BETA_PRIMARY_PORT>` |
| Beta示例 | ingress-02 | `<BETA_SECONDARY_IP>` | `<BETA_SECONDARY_PORT>` |

每个实例有独立 runtime、容器、进程、端口映射、进程代次和精确租约。两份配置指向同一协调器，包含全部十六节点；不能以另一个实例的健康或优先级替代本实例检查。Beta示例不意味着该环境已启动或允许启动。

沿用 Main-only nice=-20、SCHED_OTHER/reset-on-fork、其他线程0；不 nice 整个 Node，不授容器 CAP_SYS_NICE，不新增 CPU／内存 hard cap。入口的健康合同是 HTTP404/private-no-store 加合法 Origin 的 WS upgrade，不能套用游戏的 HTTP200/health JSON。

## WS-only Nginx 准备

`deploy/stardust/tools/prepare-dual-ingress-proxy.mjs` 只生成一个新目录中的 vhost 副本与 `proxy-preparation.json`，不安装、不修改输入、不 reload。

离线准备示例（输入与输出为占位符）：

```sh
node deploy/stardust/tools/prepare-dual-ingress-proxy.mjs \
  --source REVIEWED_ACTIVE_VHOST.conf --profile formal --out NEW_DIRECTORY
```

必须输入实际活动 vhost 的已审查副本，而非拿仓库早期单机模板覆盖线上。工具只将根 `/ws` 和已有精确 legacy WS location 的 named upstream 改为双 loopback `least_conn`，保留原 HTTP／auth／privatecode／data／material／Origin／可信转发头与超时字节。未知、重复、禁用门禁、retry 歧义及已准备输入拒绝，不 silently rewrite。

只分新 WS 握手；已有 WS 不迁移。`proxy_next_upstream error timeout`／tries2 只处理升级前的连接错误；不把 Origin403／门禁401 变成重试绕过。Nginx least_conn 不承诺所有 worker 全局严格均分。原单文件 bind 的 vhost 需保留 inode、备份与 CAS 写入，采用实际启动配置语法检查及正常 reload；HTTP 和密码门禁不接到 ingress 的404监听上。

## 管理器与单实例维护

双 edge `serve` 保持原 lifetime writer lock。root-only 本地 Unix 控制位于 `/run/<project>.control/manager.sock`，父目录0700、socket0600，SO_PEERCRED 要求 uid0；不是公共 HTTP、浏览器协议或新的私有 TCP 管理端口。

经授权维护的命令示例（路径与policy须由私有安装记录提供）：

```sh
python3 -I INSTALLED_TOOLS/cluster-host-manager.py \
  --profile formal --config APPROVED_HOST_POLICY.json --action revoke --target ingress-02
python3 -I INSTALLED_TOOLS/cluster-host-manager.py \
  --profile formal --config APPROVED_HOST_POLICY.json --action stop --target ingress-02
python3 -I INSTALLED_TOOLS/cluster-host-manager.py \
  --profile formal --config APPROVED_HOST_POLICY.json --action resume --target ingress-02
```

请求有4KiB／绝对2s接收界限，严格字段与 JSON，绑定精确 policy SHA、guard-state SHA/CAS、target、CID、进程代次和单调 control epoch。`revoke` 保留进程但撤本租约；`stop` 撤权后停确切 CID；健康轮询与管理器重启不能自动重开／重启主动停止实例。显式恢复需先核对容器、源码／runtime、代次、Main-only策略及健康，再开放仅自己的租约。另一实例的有效租约不得被一并清空。

dual-only `guard_schema:2` 先持久化精确nft transaction intent再apply；仅接受绑定policy的exact before／intended-after／safe rollback，不放宽未知drift。`closed_owners`／`start_intents`／`unadmitted` 在生命周期和admission前记录CLOSED ownership，使失败恢复可显式retry；双实例逐目标准入，失败目标不关闭健康sibling。这些状态必须纳入独立生命周期、真实kernel和native回归；不能用本地fixture替代实际Docker/systemd/WG与逐角色验收。

## 旧单实例 CLOSED guard 迁移

旧单实例和新双实例的 host-policy bytes／允许 IP 范围不同，不能往旧 guard JSON 填一条 `policy_sha256` 冒充迁移，也不能自动更新或关闭外部 WG approval 检查。

1. 在明确维护中按实际 unit／PID／policy／CID 识别并正常停旧管理器，取得确切 project writer lock；证明原批准 policy、owned table、guard state 及 inode 身份，`Guard(old).check({})` 且 lease 链确实为空。
2. 保全原 metadata，再由明确批准的新控制器进行身份／inode／SHA CAS，只替换这个 CLOSED owned edge table 与对应 guard state。不全表 flush、restore、删其他 table 或改 WG interface／peer／key／route。
3. 安装同版已验证 policy／Compose／runtime。若现有外部审批绑定 host-policy bytes，双实例必然需要显式批准的新 SHA；若只绑定未变 WG 输入，则保留其原绑定。不能让改变后的 bytes 继续冒称原 hash。
4. 新 `guard` 创建同时保护两个批准容器IP的CLOSED fence，绑定精确 policy。随后按已批准的 handoff／serve 顺序逐目标准入，全部 native generation／priority／lease 验证后才接新 WS。
5. 不停止或重启被 manager `Requires` 依赖的 WG recovery。正常退出只删除本管理器验证的 socket inode；任何 stale socket 先证明 owner inactive 和 inode 身份，再精确处理，不能通用自动 unlink。

## 验证与性能边界

- native传输检查应覆盖同池、跨入口身份归属、旧close隔离、raw字节、private0及SIGTERM/SIGKILL；FixtureMatch不是真实战斗Worker证明。
- 真实Worker/browser检查应覆盖同identity刷新、一个入口故障后的同owner恢复、观战私有隔离、门禁及触屏布局。软件渲染、手机模拟与受控波次不等于实体设备或自然整局平衡。
- 代理echo fixture只证明握手分流、门禁、Origin、已升级WS保持和升级前fallback，不是完整game验收。
- 单/双入口比较应保持连接、房间、tick、payload、PMD与调度条件相同，检查丢失、gap、duplicate和清理；同时报告最忙进程与总CPU/RSS，不能宣称CPU减半、容量翻倍或物理出口翻倍。
- 保存每实例、max、sum、owned组CPU及全hostCPU、ELU、delay、RSS/FD、bufferedAmount、注明版本的sender/socket subgauge、TCP与payload字节。不可观测队列标为unavailable，不造sendQ或重复相加subgauge。

所有实际结果留在私有记录；后续源码、镜像、私有码、静态源和逐角色核验仍需同版配套，本地proof不等于正式切换。
