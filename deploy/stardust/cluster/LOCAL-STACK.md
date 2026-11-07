# 应急同机组合栈（无 WG）

当 core 主机或 core↔入口的 WG 链路不可用、而入口主机资源足够时，可在入口主机上同时运行 coordinator、16 或 32 个 game 和本地 ingress。本文是通用流程，不是部署状态或执行授权；实际坐标、时间线和回执只放 Git 外私有记录。

这不是 HA，也不迁移内存状态：切换即结束原 coordinator/game 上的房间、会话、队列和对局。

## 拓扑

game 数量只来自已校验 core bundle 的 policy（`cluster-deploy.py --game-nodes`，Formal 可选 16 或 32，Beta 固定 16）；`cluster-local-stack.py` 没有自己的节点数参数。每 game 的 Worker 数同样只来自 core bundle（`--combat-workers 1..8`、`--trial-workers 0..2`，默认 8+2，全部 game 相同）；组合栈逐个核对 game 的 Compose 环境与 runtime 和 policy target 一致。

| core bundle | game（默认每个 8combat+2trial） | 本地 ingress | ingress loopback 端口 |
|---|---|---|---|
| 16 节点（默认） | `.11`–`.26`，`35411`–`35426` | `.31` 起，最多 8 个（`.38`） | `35401` 起（与 edge 相同） |
| 32 节点（仅 Formal） | `.11`–`.42`，`35411`–`35442` | `.51` 起，最多 16 个（`.66`） | `35451` 起（`.51`↔`35451`，到 `35466`） |

- 单一 Docker bridge = profile `core_subnet`（Formal 为 `172.30.245.0/24`）：coordinator `.2`，loopback 发布 `35400`（3000）与 `35410`（3001 私有端口）。地址/端口由 `cluster-profile.py` 固定（`game_ip`、`local_ingress_ip`、`local_ingress_host_port`），不可自定义。
- ingress runtime 直接访问 `http://<core_ip(2)>:3000` 及全部 game 的 `http://<core_ip(10+i)>:3000`；coordinator→game、game→coordinator 不变，仍是 bridge 内地址。
- 只发布 loopback，不在 WG 地址发布任何端口，WG 不再承载这套角色。16 节点栈的输出与此前完全相同。
- 角色、镜像、环境、只读/cap-drop/PIDs 等基线与 `cluster-deploy.py` 完全相同；唯一差别是 `restart: unless-stopped`，因为没有 root 管理器负责重启。

## 生成

```sh
# 1. 全新 core bundle：新节点 key，只在本机生成、不离开本机。32 节点加 --game-nodes 32（仅 Formal）；
#    每 game 少于 8+2 时再加 --combat-workers N --trial-workers M（例如 3 1 或 2 1）。
python3 -I /opt/ark-cluster-formal/tools/cluster-deploy.py --profile formal \
  --role core --game-nodes 32 --out "$NEW_CORE_BUNDLE" --image-id "$ACTUAL_IMAGE_ID" \
  --source-kind "$SOURCE_KIND" --build "$FIXED_BUILD" --manifest-sha256 "$SOURCE_MANIFEST_SHA256"

# 2. 组合栈：复用 core bundle 的 key/runtime（不改动），新增本地 ingress runtime 与 compose.json。
#    16 节点 bundle 接受 1..8 个 ingress，32 节点接受 1..16 个。
python3 -I /opt/ark-cluster-formal/tools/cluster-local-stack.py --profile formal \
  --core-bundle "$NEW_CORE_BUNDLE" --out "$NEW_LOCAL_STACK" --ingress-instances 8

docker compose -p ark-cluster-formal-local -f "$NEW_LOCAL_STACK/compose.json" config -q
```

两个输出目录都必须是不存在的新目录，父目录 root-owned 且不可 group/world 写。`stack-summary.json` 不含秘密，不是激活回执；它记录 `gameNodes` 与每个 ingress 的 service/IP/端口，供下面的 Nginx 准备逐项校验。容器数 = 1 + game + ingress：16+8 为 25 个，32+8 为 41 个，32+16 为 49 个。

### 可选：ingress↔coordinator 多路复用链路（`--ingress-link`，默认关闭）

默认每个浏览器会话在 ingress 与 coordinator 之间各有一条 WS；开启后每个本地 ingress 只保持 1 条经认证的长连接（`/_cluster/link`，coordinator 私有监听 `core_ip(2):3001`），承载该 ingress 的全部会话（设计见 [README.md](README.md#入口多路复用链路)）。

```sh
python3 -I /opt/ark-cluster-formal/tools/cluster-local-stack.py --profile formal \
  --core-bundle "$NEW_CORE_BUNDLE" --out "$NEW_LOCAL_STACK" --ingress-instances 8 --ingress-link
```

- 只在新组合栈目录生成 `link-keys/<ingress>.key`（每 ingress 一个新的 32 字节随机 key，root:1000 0440），不写入、不复制 core bundle；key 不进 argv/env/日志，丢失或泄露即整体重新生成组合栈。
- 每个 ingress 只挂载自己的 key 到 `/run/secrets/link.key:ro`，runtime 增加 `link: {url: http://<core_ip(2)>:3001/, ingressId: <service>, keyFile}`；coordinator 改用组合栈内派生的 `runtime/coordinator/runtime.json`（= 已校验的 core runtime + `ingresses` 列表），并只读挂载 `link-keys/` 到 `/run/link-secrets`。core 的节点 key 与原 runtime 不变。
- 不加该选项时输出与之前逐字节相同。切回直连 = 用不带 `--ingress-link` 的组合栈整体替换（同样结束内存局）；运行中不能逐个 ingress 切换。WG/受管拓扑尚不支持链路（需放行 ingress→coordinator:3001 的租约规则与 host-manager mount 合同）。
- 验证：`docker compose ... config -q`；启动后 coordinator `/healthz` 的 `sockets` 应等于在线会话数，宿主 `ss -tn` 上 ingress→coordinator:3000 的连接数应接近 0、→:3001 每 ingress 1 条。

### 可选：对局存档 Valkey（`--valkey`，默认关闭）

开启后重启（发版、只重启 coordinator、某个 game 重启）时进行中的对局可以接着打，行为见 [docs/DEPLOY.md §13](../../../docs/DEPLOY.md#13-断点续玩重启后接着打可选valkey)。

```sh
python3 -I /opt/ark-cluster-formal/tools/cluster-local-stack.py --profile formal \
  --core-bundle "$NEW_CORE_BUNDLE" --out "$NEW_LOCAL_STACK" --ingress-instances 8 --valkey [--valkey-maxmemory-mb 2048]
```

- 新增一个 `valkey` 服务：镜像 `valkey/valkey:9.1.2-alpine3.24` 按摘要固定（`VALKEY_IMAGE`，`pull_policy: never`，部署前须先在宿主机 `docker pull`/`load` 并核对摘要），地址 `core_ip(5)`（Formal `172.30.245.5`），**不发布任何端口**，只在 bridge 上；以镜像自带用户 `999:1000` 运行，只读根文件系统、`cap_drop: ALL`、`no-new-privileges`。
- 数据在 Compose 命名卷 `valkey-data`（AOF 每秒落盘，`maxmemory` 默认 2048 MB，`volatile-ttl`）。同一 project 名的新组合栈沿用这个卷；只要 `valkey` 服务定义不变，`docker compose up -d` 换栈时它不会被重建，存档在内存里一直可用。
- 只在新组合栈目录生成一个新的随机密码：`valkey/valkey.conf`（含 `requirepass`，只挂进 `valkey`）和 `valkey.pass`（root:1000 0440，只读挂进 coordinator 与全部 game 的 `/run/store/valkey.pass`；不放在 `/run/secrets` 下，因为 coordinator 把整个 keys 目录只读挂在那里，嵌套挂载点建不出来，rel17 首次切换因此失败）；密码不进 compose.json、环境变量、argv 或 summary。
- coordinator 与每个 game 增加 `SP_REDIS_URL=redis://<core_ip(5)>:6379/0`、`SP_REDIS_PASSWORD_FILE`、`SP_REDIS_PREFIX=<profile>:` 和 `depends_on: [valkey]`（停止时先停角色、让它们写完最后一次存档，启动时先起存储）；ingress 不连存储。`stack-summary.json` 增加 `checkpointStore`（服务、镜像、地址、内存上限、前缀，无秘密），容器数加 1。
- 不加该选项时输出逐字节不变。主线程优先级工具（`main-thread-priority.py --profile local`）按固定目标清单核对，开启前要确认它不把多出的 `valkey` 容器当作未知目标拒绝（它不是 Node 角色，不调优先级）。
- 启动顺序：`depends_on: [valkey]` 只保证先起容器，不等它可用；主机重启时 Docker 按 `restart: unless-stopped` 同时拉起全部容器，根本不看 `depends_on`。所以由代码兜底：coordinator 启动读存档时等 Valkey 最多 60 秒（连不上、超时、`LOADING`），期间不监听，game 读存档遇到同样情况回 `NOT_READY` 由 coordinator 重试（[docs/DEPLOY.md §13](../../../docs/DEPLOY.md#13-断点续玩重启后接着打可选valkey)）。带这一修复的镜像起，换栈脚本不必再手动先起 `valkey` 等 Ready（rel18 及更早的镜像仍需要）。
- 不给 `valkey` 加 healthcheck + `depends_on: condition: service_healthy`：它管不到主机重启（同上），却会让存储不健康（AOF 损坏、配置错误、加载超过等待期）时 `docker compose up` 拒绝启动 coordinator 与全部 game，把「存储坏了只是不存档」变成「存储坏了游戏起不来」；改 `valkey` 服务定义还会让下次换栈重建存储容器。
- `cluster-deploy.py` 没有 Valkey 选项，也不加：core bundle 的 compose 服务必须与 `host-policy.json` 的 targets 一一对应，`cluster-host-manager.py` 按固定安全基线逐个核对并按租约管理（存储不是 Node 角色，没有 runtime 和租约），本工具也要求 core bundle 恰好是 coordinator + game。存储只属于组合栈（bridge 内、不发布、每栈一个前缀），用本工具的 `--valkey`；WG/受管拓扑要存档需另行设计存储的生命周期与租约规则。

### 在线上限与服主文件（`--online-limit-dir <目录>`）

把宿主机目录只读挂到 coordinator 的 `/run/limits`，并给它设 `SP_ONLINE_LIMIT_FILE=/run/limits/online-limit.json`（在线上限与房间/AI 配额，`server/onlineLimit.js`）和 `SP_OWNER_FILE=/run/limits/owner.json`（服主文件，`server/ownerFile.js`）；两个文件都可以不存在（不限 / 无服主），运行中改文件即生效。挂目录而不是文件，编辑器或 `mv` 换掉文件后仍然有效。目录须已存在、在仓库外且属于本 profile 的路径、无符号链接、属主为运行工具的用户且不可 group/world 写；game 与 ingress 不挂。`stack-summary.json` 记 `onlineLimitDir`。不加时输出不变。

### 服务器开关（`--server-env KEY=VALUE`，可重复）

给 coordinator 与全部 game 加环境变量开关（ingress 不加），只接受 `SERVER_ENV` 里的键和取值：`SP_PLUGINS=off|host|fixed`、`SP_PLUGIN_SCRIPTS=off|sandbox`、`SP_CSP=off`、`SP_STUDIO=off|local|lan`、`SP_BOT_REHEARSAL=host`；core bundle 已带同名变量时拒绝。`stack-summary.json` 记 `serverEnv`。不加时输出不变。

生产（rel17 起，服主 2026-10-16 决定：不开插件房/脚本插件/创作工坊，不加站点 CSP）：

```sh
python3 -I /opt/ark-cluster-formal/tools/cluster-local-stack.py --profile formal \
  --core-bundle "$NEW_CORE_BUNDLE" --out "$NEW_LOCAL_STACK" --ingress-instances 16 --online-limit-dir /opt/ark-cluster-formal/limits \
  --ingress-link --valkey --valkey-maxmemory-mb 2048 \
  --server-env SP_PLUGINS=off --server-env SP_CSP=off --server-env SP_STUDIO=off
```

## Nginx 与私有码（生成器，不再手改）

```sh
# WS upstream = stack-summary 中的全部本地 ingress（:3000）；game backend 与可选 ingress backend 精确改址；
# 443 两个 listen 加 reuseport backlog=4096。输入是现用 vhost 的已审查副本，输出为新目录。
node deploy/stardust/tools/prepare-dual-ingress-proxy.mjs --profile formal --source REVIEWED_ACTIVE_VHOST.conf \
  --topology local --stack-summary "$NEW_LOCAL_STACK/stack-summary.json" --tls-listen-backlog 4096 \
  [--replace-prepared] --out NEW_DIRECTORY

# 私有码 fallback（^~ /js/、^~ /css/、@ark_formal_cluster_code）指向 coordinator 的 bridge 地址。
python3 -I /opt/ark-cluster-formal/tools/cluster-private-code.py --profile formal --topology local ... --out "$NEW_PRIVATE_STAGE"
python3 -I /opt/ark-cluster-formal/tools/cluster-private-code.py --profile formal ... --verify "$NEW_PRIVATE_STAGE"
```

- 直连 bridge：WS upstream 是本地 ingress 的容器 IP:3000，`ark_proto_game_backend` 与私有码 fallback 是 coordinator `core_ip(2):3000`（Formal `172.30.245.2:3000`），`ark_proto_ingress_backend`（若存在）是第一个本地 ingress:3000。宿主 Nginx 直达 bridge，绕过 docker-proxy 用户态转发（与 WG edge 的 container-direct WS 同理）；loopback 发布端口保留给本机检查与回退。
- `--topology local` 仅 Formal；summary 必须是 `cluster-local-stack.py` 原样输出，数量、IP、端口与 16/32 布局逐项一致，否则拒绝。game backend 只接受已知旧值（WG coordinator 发布地址或此前手改的 `127.0.0.1:35400`）或已是目标；ingress backend 只接受 WG edge 的 ingress-01 或任一本地布局的第一个 ingress。未知、重复的 upstream/server 均拒绝；keepalive 等参数原样保留。`proxy-preparation.json` 记录 topology、summary 摘要和每个改址的前后值。
- `--tls-listen-backlog 4096` 只改恰好一条 `listen 443 ssl;` 与一条 `listen [::]:443 ssl;`，已是同值时不变，其他 443 选项拒绝；80 不动。同一宿主其他站点不得在 443 上重复声明 listen 参数，以 `openresty -t` 为准。
- 已准备过的 vhost（WS upstream 已存在）默认仍拒绝；显式 `--replace-prepared` 只替换文件开头一个与先前生成器输出逐字节相同的 WS block（WG 形式，或 local 下的任一本地布局），各 WS location 必须仍是生成的 proxy_pass/retry 原样。local 输出不能用 WG 模式重准备；回到 WG 用备份恢复。
- 私有码 `--topology local` 只写入非默认的 `topology` 到 release metadata（WG 输出字节不变）；`--verify` 按记录的 topology 重建，显式给出不同的 `--topology` 即拒绝。

## 切换（需当前明确授权）

1. 记录现有 edge/Nginx 配置与容器身份作为回滚材料。
2. `systemctl stop ark-cluster-formal-edge`，再用原 policy `cluster-host-manager.py --action stop` 停旧 ingress（释放同一组 loopback 端口），`systemctl disable ark-cluster-formal-edge`。旧容器与 policy 保留，不删除。
3. `docker compose -p ark-cluster-formal-local -f "$NEW_LOCAL_STACK/compose.json" up -d`，确认容器数与上表一致、`127.0.0.1:35400/healthz` 正常。
4. Nginx 与私有码换成上一节生成并审查过的输出；`formal-open.conf` 等待用候选配置同样用生成器更新，避免以后被装回旧拓扑。先 `openresty -t`，再一次正常 HUP。
5. 按 [ark-cluster-formal-local.service](ark-cluster-formal-local.service) 安装 unit（替换 `<local-stack>`），`systemctl enable --now`。它与 edge unit 互斥：把 `/etc/systemd/system` 下的 edge unit 文件移到备份目录后 `systemctl mask ark-cluster-formal-edge.service`，防止误启动时 `Conflicts=` 先把本栈整体停掉。
6. 公网 TLS/healthz/WS 与浏览器验收另行进行。

### 16 → 32 节点

新旧组合栈使用同一 Compose project `ark-cluster-formal-local`、同一 coordinator/game 端口与 bridge 地址，**不能并行运行**，只能整体替换，并结束全部内存房间与对局。事先生成新的 32 节点 core bundle（新 key）、新组合栈，以及用 `--replace-prepared` 从现用 vhost 生成并 `openresty -t` 预检过的候选 vhost 与 `--topology local` 私有码。授权窗口内：

1. `systemctl stop ark-cluster-formal-local`（按旧路径 stop），再 `docker compose -p ark-cluster-formal-local -f "$OLD_LOCAL_STACK/compose.json" down` 移除旧容器；旧目录与 Nginx 备份保留供回滚。
2. 先换 Nginx/私有码并 HUP，再起新栈：旧 vhost 的 `.31`–`.38` 在 32 节点布局中是 game-21..28 的地址，不能让旧 WS/ingress upstream 在新栈运行时指向它们。
3. unit 中 `<local-stack>` 改为新目录并 `daemon-reload`，`systemctl start ark-cluster-formal-local`，确认 41（8 ingress）或 49（16 ingress）个容器与 healthz。

回滚按同样顺序整体替换回旧栈与旧 Nginx 备份。

## 单机运行加固

同机栈没有第二台主机兜底，任何 Docker 守护进程重启都会结束全部内存对局，因此：

- unit 使用 `Wants=docker.service` 而不是 `Requires=`：显式 restart docker 时 `Requires=` 会联动 restart 本 unit，`ExecStop` 会停掉全部容器。
- `/etc/docker/daemon.json` 开启 `"live-restore": true`，先 `dockerd --validate --config-file /etc/docker/daemon.json`，再 `systemctl reload docker`（只 SIGHUP，不重启容器）。
- unattended-upgrades 的 `Package-Blacklist` 加入 `docker.io`、`containerd`、`runc`、`docker-compose-v2`；needrestart 对 `docker`、`containerd` 设 `override_rc` 为 0。Docker 只在维护窗口手动升级。
- proxy 写入宿主的 access/error log 加 logrotate（daily、copytruncate，无需向 proxy 发信号）。
- 入口 Nginx 的 443 监听用 `--tls-listen-backlog 4096` 生成 `reuseport backlog=4096`，避免单个 worker 接收绝大多数长连接；HUP 即可生效，已有连接留在旧 worker 自然结束。
- 客户端 TCP 可用 `bbr`、`tcp_slow_start_after_idle=0`、`tcp_notsent_lowat=16384`，只影响新连接；写入 `/etc/sysctl.d/` 并在 `modules-load.d` 加载 `tcp_bbr`。
- 不再使用的 WG recovery unit 只 `disable`、不 `stop`；其接口与 nft 表在确认不回滚后再清理。

## 回滚

`systemctl disable --now ark-cluster-formal-local` → 恢复 Nginx 备份并正常 HUP → `systemctl unmask ark-cluster-formal-edge.service`、从备份放回 edge unit 并 `daemon-reload` → `systemctl enable ark-cluster-formal-wg` → `systemctl enable --now ark-cluster-formal-edge`。回到 WG 拓扑的前提是 core 主机和链路已恢复并重新经过原有 guard/handoff/lease 流程。

## 已知限制与正式化

- 这套栈不受 `cluster-host-manager.py` 管理：没有 nft 租约 guard、CAS 状态或逐角色健康撤租；Main-thread 优先级由 `main-thread-priority.py --profile local` 单独提供（见 [MAIN-THREAD-PRIORITY.md](../MAIN-THREAD-PRIORITY.md#local-profile)）。容器端口仅 loopback，bridge 由 Docker 隔离。`cluster-host-manager.py` 能解析 32 节点 policy（core 与 WG edge 的目标、key 与租约端口随之扩展），但这不等于本栈已纳入管理。
- 正式化方向：host policy 增加 local 模式（core 项目内含 ingress 目标、只 loopback 映射、跳过 WG `network_ready`）、lease 规则放行 ingress→coordinator/game:3000、对应 unit（无 WG 依赖/handoff），以及相应测试。
