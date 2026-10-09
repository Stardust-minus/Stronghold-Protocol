# 独立 Beta 准备与发布

Beta 是独立验收环境，不是 Formal 的滚动版本、备用路由或房间迁移入口。示例 origin 为 `https://beta.game.example.com`，Formal 为 `https://game.example.com`；具体部署路径、坐标与回执保持私有。本文不声明任何环境已启动或验收，准备命令也不是执行授权。

## 环境隔离与模板范围

- Beta 的 backend/profile、房间、队列、会话、Cookie 签名、Origin、vhost/TLS、私有码和守卫租约独立。一个环境的发布、停止或版本变更不自动同步另一个环境；停用 Beta 不因旧材料存在而自动恢复。
- `compose.beta-game.yaml` 是**单体 Beta**模板：project/container `ark-proto-beta`，12 combat + 2 trial，host 发布端口3220，loopback 与受保护 WG 绑定；`compose.beta-edge.yaml` 配套独立 auth3241/resolver3230。不同主机的 Compose 网络独立。
- `compose.core-game.yaml` 的单体 Formal `core` 为12+2/3120，旧简单 `prod` 模板为6+1/loopback3120。这些是固定模板合同，不表示当前采用哪种架构；不能把 profile 当任意容器/端口/地址 selector。
- **集群 Beta**改用 `cluster-deploy.py --profile beta` 与 `cluster-host-manager.py`，按 [CLUSTER-SOP.md](CLUSTER-SOP.md) 管理 coordinator/game/ingress。全局大厅和匹配池仅在 Beta 内共享，不与 Formal 合并；单体 GET health/12+2 manager 不适用于 worker0 coordinator/ingress 或认证 RPC game。

现有 profile、Origin、地址及工具摘要绑定来自受审查版本化源码；示例域名不是任意替换即安装方案。安装前读取真实运行配置和对应模板，不能用单体模板覆盖集群。

## 固定候选与配套资源

1. 在独立分支保留工作树，完成代码和隔离本地验证；取得相应源码发布授权后固定完整 commit。源码/记录 HEAD 与运行镜像身份分开。
2. 从固定源码导出不存在的新目录，逐 Git blob 核对，拒绝链接、路径穿越、设备与额外库存。依赖/vendor/art 复用仍验证 lock、manifest 和 bytes；集群使用 `tools/cluster-source-export.py`，单独纳入 generated renderer index，不漏掉 ignored `data/local-assets.json`。
3. game/auth/resolver/privatecode/host-tools/runtime 分别记录身份和清单。宿主调度/防火墙程序、systemd、秘密和证据不进入 game app 或公开素材。
4. 固定 Node 基础镜像 digest，离线无 pull 构建；核对真实 immutable image ID、OCI source/revision、RootFS/source/resource 清单。挂工作树的测试基础镜像不能冒称候选镜像。
5. 同字节 immutable 素材可经严格清单复用，核对实际 provider pin/prefix、alias、正文/hash 与同版本 fallback。旧素材不天然匹配新代码，不覆写已发布目录，不重传来绕过源站例外。

协调发布与回退遵循 [UPDATE-SOP.md](UPDATE-SOP.md) 和 [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md)，WS 压缩须按自身 profile 显式核对，不因 Formal 启用而假定 Beta 相同。

## 私有业务代码落盘

`tools/prepare-localcode-release.mjs` 只准备固定 commit、逐 URL 白名单的 `/js/*.js` 和 `/css/*.css`，不是公开 static 准备器或通用 proxy cache。

```sh
node deploy/stardust/tools/prepare-localcode-release.mjs \
  --namespace beta --source "$APP_EXPORT" --revision "$COMMIT" --repo "$REPO" --out "$NEW_STAGE"
node deploy/stardust/tools/prepare-localcode-release.mjs \
  --verify "$NEW_STAGE" --namespace beta --revision "$COMMIT" --repo "$REPO"
```

- 输出父目录已存在且 `NEW_STAGE` 不存在；工具验证实际 Git blob、精确库存和 SHA，不激活服务。落盘位置使用 `<BETA_LOCALCODE_ROOT>/<commit>/`，只经生成的精确 location 供给。
- 命中、HEAD、条件请求/Range、缺失回源都保留门禁和浏览器 `private,no-store`；不把 `?v=` 当可信版本。
- named fallback 在 Beta vhost 定义，继续门禁且只指向同候选 Beta backend，不能掉入 Formal upstream。
- HTML、shared/sim/data、`/data.js`、`/client-build`、API/WS/auth 不落盘缓存。`/js/data.js` 是 tracked loader，不等于生成 shim `/data.js`。
- root hooks adapter 取同候选 Beta game 原件；其他库/字体/美术按配套清单，不能混 Formal 的 Preact 身份。

## 门禁、秘密、证书与挂载

- auth 显式 `AUTH_PROFILE=beta`，可信 Host/Origin 由固定 profile 决定，不从请求头推导或改写成 Formal Origin。保持口令、昵称校验、CSRF、登录限速、安全头和内部端点隐藏。
- 若经批准复用口令 salt/hash，仍须独立生成32-byte Beta 签名 key，不整份复用 Formal secrets。UID、所有权、权限和只读 secret mount 按安全基线核对；秘密不进入镜像、源码、参数、日志或证据。
- 自动检查中的内存授权 Cookie 需明确标注，不能冒称真实口令录入；不输出或保存 Cookie/签名 key/verifier。
- Beta 使用独立证书/目录；HTTP-01 仅提供 challenge，不覆盖其他证书或 ACME 账户。TLS/续期操作另行授权，不假定已有自动续期。
- `nginx/ark-proto-beta.conf` 的 `__STATIC_RELEASE__` 仅在配套字节核验后替换，不能原样安装占位配置。
- 按实际代理挂载和启动配置做 `nginx -t`/正常 reload，不重启代理或 Formal game/auth。目录 bind 可按已核对身份 CAS替换；单文件 bind 保留 inode、备份和原字节 CAS。错误默认 PID/Host probe 不构成降低 read-only/Host 检查的理由。
- resolver 元数据清单须对容器 Node UID 可读，容器目的路径 `/run/config/openi-assets.json` 与 `ASSET_MANIFEST` 一致；此公开元数据可读规则不能套到 auth/verifier/signing 文件。保持 readonly mount，替换宿主文件时核对实际容器读到的 inode/内容。

## WG、Docker 与启动次序

WG 只提供明确 peer `/32` 的业务通道，不是跨 LAN 路由。保持其他网络、默认 route、全局 FORWARD/NAT/sysctl。仅绑定 WG 地址或 INPUT 放行不足：Docker DNAT 后进入 FORWARD，也可能从其他接口访问目标地址/容器 IP。

1. 启动前安装本 profile CLOSED 护栏，覆盖固定容器 IP/端口与 conntrack 原目的 WG IP/发布端口；未批准 iface/peer/非业务转发保持 DROP。
2. 单体用独立 Beta Compose，托管 game 保持 `restart=no`，防止 Docker 早于护栏恢复。集群按每角色同样先闭锁，不使用单体管理器。
3. 验证完整 CID/image/source/runtime SHA、namespace/Compose 所有权、安全基线、唯一网络/固定 IP/映射和真正 process generation，再检查对应角色健康。单体12+2须验证池与 Linux WorkerThread；集群 game8+2、coordinator/ingress0使用各自合同。
4. 受 root-owned 精确白名单批准的 priority helper 先设普通 `SCHED_OTHER` + reset-on-fork，再仅 Main nice=-20，其他 Worker/V8/libuv/辅助线程0。不 nice 整个 Node、不加 CAP_SYS_NICE/CPU/内存 hard cap，保留 PIDs/read-only/cap-drop/no-new-privileges。
5. 只在全部条件成立后原子开放租约：可信 WG 入接口/peer 源、原目的发布地址/端口、核准容器 IP/端口全部匹配，回复仅同连接反向。CID/generation 由 manager 验证，不是 nft 字段；端口重新监听不恢复旧 owner。
6. 重建/身份变化先撤旧租约、保持 CLOSED，新启动使用新的不可复用 generation；漂移或健康/priority 失败拒绝开放。只修改专属表/链/state，不全表 flush/restore、放开 Docker 网段或依赖早期 ACCEPT 覆盖后续 CNI/Docker DROP，验证完整链路。
7. 单体 `game-backend-manager.py` 按固定 profile 执行 guard→Compose→priority→open 与周期 lease 复核，生命周期锁 fail-fast、共享 WG 锁有界；托管角色不另启同 profile priority watcher。集群双 ingress 的 schema2 journal、逐 target admission、CLOSED ownership、policy/state SHA/CAS 与显式 scoped resume 见 [cluster/DUAL-INGRESS.md](cluster/DUAL-INGRESS.md)。
8. [WG-BOOT-RECOVERY.md](WG-BOOT-RECOVERY.md) 定义 WG/关闭护栏先于 manager 的依赖。冷启动先闭锁，再恢复 peer/route；已有精确完整运行状态须幂等保留。停 manager 会撤其租约并停批准 CID；显式停/restart 被 `Requires` 依赖的 WG recovery 会连带停止 manager/game，不能用于 Beta 更新。
9. 安装依赖与 enable 不等于整机重启实测；验证配置、隔离冷启动和实际重启分别记录。不能为测试依赖顺带 restart 活跃 Formal/WG。
10. 获授权升级时仅维护 Beta 入口，完成新 game/resolver/privatecode/material 就绪再开放；比较 Formal vhost hash、CID/PID/start/restarts 与租约，确认无越界影响。源码、提交、素材预置不授权切流。

## 验收、授权与证据

- Beta 真实检查门禁、Host/Origin/CSRF、跨签名 key 拒绝、可信 WS 转发、内部 health 隐藏、私有码命中/同版 fallback、资源/Preact 单身份。
- 按改动检查 PRTS 动画、实际 UI/触屏、Worker 战斗/试算/匹配/购买部署/同身份重连与观战私有隔离。只默认跳片头，保留组装、成功和进入转场及 reduced-motion/立即进入兜底，首次/重入仍验证身份/profile。
- 粗负载来自近窗口缓存的主线程响应压力，不是整机 CPU/Worker 容量；未就绪、缺失、过期显示未知，不能公开内部 health 或增加无谓轮询。
- canonical、mock、真实进程/Worker、浏览器画面、手机模拟、实体设备和完整规模分别记录；不生产压测、Inspector、heapdump、busy 注入或清他人房间。真实失败/skip不改称通过。
- Beta 的具体部署/维护需明确用户授权；正式发布独立确认环境、组件和窗口，不因 Beta 上线、推送、用户离线或时间到达而自动触发。
- 内存房间/对局不能跨机迁移；重建会丢失状态，镜像回滚不能恢复。事先说明并确认维护影响，切换后客户端刷新，game/privatecode/material 同步。

具体坐标、组件身份、阶段回执、失败与 skip 保存在 ignored `.claude/releases/` 或仓库外私有归档，遵循 [releases/README.md](releases/README.md)；公开指南不保存实际活动快照、日志或历史授权。

## 精确回退

先核对当前身份、对局影响与回滚授权，再停止新 Beta 入口流量、撤其专属租约、按批准 CID 停止/替换对应角色。恢复匹配的 game/privatecode/data/renderer resources/resolver/material/pin/profile；auth-only 则仅撤本批 auth/CSP。只合并现用配置必要段落，不覆盖其他修改或清空健康 sibling 的租约。

保留 Formal、共享 WG/recovery、其他站点和服务，不 flush ruleset、删共享网络、卸载模块、自动清旧镜像/immutable资源或重放已消费控制器。回滚和清理是独立授权；保留上一完整回退单元和私有原始失败记录，不宣称丢失的内存局已恢复。
