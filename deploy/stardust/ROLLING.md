# 保留旧局的滚动发布

## 已实现的边界

这是 **旧对局继续运行在旧进程，新入口进入新版本**，不是任意正在进行的对局迁移、内存存档、Worker 热替换或 CRIU。旧 Match、会话 Token、棋盘、经济、RNG、计时器、Worker 权威及结算仍由原进程持有；切换只改新入口和新局准入，不冻结或重新创建旧 Match。

- 稳定的原生 Node HTTP/WS gateway 绑定 `127.0.0.1`，放在现有 Nginx/共享口令门禁之后。
- `/` 302 到 `/_release/<current>/public/`；只保留单一、安全的 `room` 查询参数，不转发 Token、任意目标 URL 或端口。`/_release/<id>/` 同样重定向到这个 canonical 页面。
- 旧标签页、模块、数据、素材和 WS URL 固定为 `/_release/<old>/…`。断线重连仍接原后端，绝不偷偷接到 current。未知版本 404，已退休版本 410，不可用版本明确失败。
- activate/rollback 不关闭任何旧/new WS tunnel，不终止后端。rollback 只把 **未来入口** 指向另一已注册、健康的版本，新版本已开始的局仍留在那里。
- 每次切换先验证目标的私有状态、HTTP 后端身份与素材解析器身份，关闭旧准入，再打开目标准入，最后原子保存 routing state。不是跨进程事务；中途失败可能让旧入口保持 draining，需显式重试或修复，不能宣称失败完全无感。
- draining 拒绝新建房间、新加入房间、开始新局和新排队；同房间重入/同步和进行中游戏不变。已存在但尚未开局的房间也不能在 draining 版本启动，完成后的房间不能再开一局。
- 队列按后端/版本独立，不合并不同 release 的玩家。新 standby 必须以 draining 启动；gateway 启动/reload 检查可达 standby 的状态。
- 玩家只在没有进行中游戏时明确选择进入新版本。**此实现没有跨进程 idle 身份导出/import/fence**；这个选择可能生成新 playerId/Token。旧游戏身份始终留在旧版本，不能把“换版本”当恢复对局操作。

**首次安装不适用于当前线上旧版内存。** 现有生产 0.1.2 无 release 路径/私有控制接口。首次维护仍需等待旧局清空、说明影响并取得窗口授权；不能用未来能力证明旧进程可以被重建后恢复。当前文档和代码不授权部署、重启或自动切流。

## 进程与私有控制

实现文件：`server/rolling/{gateway,control,backend,material,cli}.js`，游戏入口只增加窄的 lifecycle adapter。没有 Redis，没有公共 admin HTTP 路由，没有 shell/process kill API。

游戏后端配置：

```sh
HOST=127.0.0.1 PORT=3201 \
SP_RELEASE_ID=game-r1 \
SP_ROLLING_CONTROL_SOCKET=/run/ark-rolling/game-r1.sock \
SP_ROLLING_DRAINING=0 \
node server/index.js
# staged 后端用另一个端口、ID、socket，并设 SP_ROLLING_DRAINING=1。
```

`SP_RELEASE_ID` 与 control socket 必须同时设置。release ID 为 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`；不能复用同 ID 的代码/数据/素材或后端目标。程序调用可用 `startServer({port, host, releaseId, controlSocket, draining})`，返回 `.rollingControl`；未配置时原单后端启动方式保持不变。

UDS/state/config/registry 的父目录必须已存在、归当前 UID 所有、无 symlink，权限 `0700`；JSON/state 和 socket 为 `0600`。gateway 与后端须使用能访问这些目录的同一服务 UID。容器使用专用共享 runtime mount，核对 UID 和宿主端口只映射到 loopback；不要把游戏管理面或后端端口映射到公网。不要把 `/run` 整体设为共享可写。

UDS HTTP 只接受无 Origin、非 chunked 的 `POST /control`，有 8 KiB body 上限、超时与 schema 校验。另一个已存在的 socket（包括疑似 stale）不会自动 unlink。进程退出遗留的 socket 必须先确认没有活进程/监听，再由操作员处理，不会误接管别人的 listener。

私有 backend 命令：

- `{op:'status'}`：`{ok,releaseId,version,app,draining,currentReleaseId,rooms,matches,sessions,retainedSessions,queued,online,lobbyOnline,matchOnline,queueOnline,canRetire}`。
- `{op:'drain',draining:boolean,currentReleaseId:string}`：同步设置准入并推送服务状态。`releaseId` 是这个后端的不可变身份；`currentReleaseId` 是提示玩家前往的入口版本，二者不能混淆。

## 不可变 registry 与持久 state

启动命令：

```sh
SP_ROLLING_CONFIG=/run/ark-rolling/gateway.json node server/rolling/gateway.js
```

`gateway.json` 的结构如下；示例域名/ID/端口只是结构，不是部署记录。`manifestHash` **必须替换为实际 manifest 原始文件字节的 64 位 SHA-256**，不要复制下方占位字符串启动：

```json
{
  "port": 3190,
  "publicOrigins": ["https://game.example.test"],
  "trustedProxyAddresses": ["127.0.0.1"],
  "staticOrigins": [
    "https://obs.cn-south-222.ai.pcl.cn",
    "https://ark-asset.hanabi-ai.cn:25442"
  ],
  "activeReleaseId": "game-r1",
  "registryFile": "/run/ark-rolling/registry.json",
  "stateFile": "/run/ark-rolling/state.json",
  "controlSocket": "/run/ark-rolling/gateway.sock"
}
```

`registry.json`：

```json
{
  "releases": [{
    "id": "game-r1",
    "port": 3201,
    "controlSocket": "/run/ark-rolling/game-r1.sock",
    "assetResolver": {
      "port": 3110,
      "materialReleaseId": "material-r1",
      "mirrorReleaseId": "openi-r1",
      "manifestHash": "<sha256-of-exact-mounted-manifest-file>",
      "ossOrigin": "https://obs.cn-south-222.ai.pcl.cn",
      "ossPathPrefix": "/bucket/dataset-uuid/releases/openi-r1/",
      "fallbackBase": "https://ark-asset.hanabi-ai.cn:25442/releases/material-r1/"
    },
    "staticRoutes": {
      "fonts": {
        "materialReleaseId": "material-r1",
        "redirectBase": "https://ark-asset.hanabi-ai.cn:25442/releases/material-r1/fonts/"
      },
      "vendor": {
        "materialReleaseId": "material-r1",
        "redirectBase": "https://ark-asset.hanabi-ai.cn:25442/releases/material-r1/vendor/"
      }
    }
  }]
}
```

每个新版本另加 entry，后端 port/socket 不可与其他版本复用。`reload` 只新增 allowlist，并检查原有映射没有改变；从输入清单删掉旧 entry **不是**退休操作。持久 state 保存所有已知映射、current 和 retired，`0600` 临时文件、文件 fsync、同目录 rename 和目录 fsync；重启以 state 的 current 为准，不以 config 默认值回退。已退休 ID 不能重新 activate，也不能改成指向另一个版本。stateFile 丢失/损坏或人为覆写不在不中断保证内，应备份并 fail closed，不能重新绑定旧 URL。

Programmatic gateway：`startGateway({port, publicOrigins, trustedProxyAddresses, staticOrigins, activeReleaseId, registryFile, stateFile, controlSocket})`；测试可用 `releases:[…]` 代替 registryFile。返回 `{server,port,control,close}`。close 清理 listener/timers/tunnels，不调用任何 backend 的 close。gateway 重启/崩溃会断掉 tunnel，但在旧 backend 仍运行且仍处于原重连保留窗口时，客户端可按旧 URL 恢复。**后端自身崩溃/重启会丢内存；此方案不提供容灾存档。**

仅隔离本地测试允许 `allowLocalStatic:true` + release entry `localStatic:true`，直接代理对应游戏 backend 的本地资源。生产默认禁止这一选项，不能借测试配置把字体/vendor/普通图片都搬回嘉兴。

## OpenI 与同版本 fallback

正常 `/assets/`、`/media/` 请求先到注册的 loopback OpenI resolver，不经过当前全局素材 location，也不把普通图片直跳宁夏。gateway 只转发已剥前缀的精确路径，以及 Origin、Sec-Fetch-Mode、Range/If-Range；不传 Cookie、Authorization、Proxy-Authorization 或任意目标 origin。resolver 返回签名 302，图片正文仍由 OBS 提供，显示/CORS 的 `sp_request` 模式分别保留；音频保持无扩展名。

- gateway 查询 resolver 的 **metadata-only `GET /_material`**：`{release,manifestHash}`。production hash 是实际挂载 manifest 原始 bytes（含空白）的 SHA-256。
- 新 endpoint 不改变 `/healthz` 的原有 loopback-only 限制。Docker 宿主请求通常来自 bridge，health 仍 404；`/_material` 不含 counters、对象地址、签名或 Token，gateway/Nginx 公共面都必须屏蔽它。
- 旧 v3 resolver 没有此 endpoint，不能不验证就用于 rolling staging；下一次获授权的统一发布需准备新 resolver image。不会修改现用 3110/3111 实例。
- gateway 的 `ossPathPrefix` 是 **完整 mirror 对象前缀**：resolver manifest 的 `ossPathPrefix` + `releases/<mirrorReleaseId>/`，不是仅 bucket/dataset UUID。`materialReleaseId` 对应 resolver manifest `release` 和宁夏 fallback；mirror ID 可能不同，不能混用。
- identity/hash 不符直接失败，不偷偷 fallback，更不能拿其他 release 的 resolver 顶替。返回的 OSS origin/object-prefix 或 fallback release 不符也失败。
- resolver 不可达/超时/5xx 时仅跳该 entry 的 pinned fallbackBase。HEAD 按现有 resolver 规则走同版本宁夏。未知路径由 resolver/static exact whitelist 拒绝。
- fonts/vendor 仍 302 到匹配的宁夏 immutable release；不代理正文到嘉兴。保留 CORS、MIME、字体相对 URL、Preact 单实例和模块的 release 路径语义；旧 `hooks.module.js` 固定根 `/vendor/preact…` 的发布补丁不能盲目复用于多个并存版本。

registry 的身份声明不是文件内容的自动证明。仍按 `UPDATE-SOP.md` / `OPENI.md` 上传、逐文件核对配套 code/data/lockfile/vendor/字体/assets/media 清单，记录镜像和完整 commit；未核对 material 的版本不可 activate。公开静态权限不延伸到游戏代码、data 或 WS。

滚动静态准备 **必须** 指定 gateway 的游戏 release ID，不使用 legacy 全局 Preact 补丁：

```sh
node deploy/stardust/tools/prepare-static-release.mjs \
  --source "$APP_EXPORT" --revision "$SOURCE_REVISION" \
  --release "$STATIC_RELEASE" --game-release "$GAME_RELEASE_ID" --out "$NEW_STAGE"
node deploy/stardust/tools/prepare-static-release.mjs --verify "$NEW_STAGE"
```

`gameReleaseId` 写入 release-manifest；verify 校验安全 ID 和 staged hooks 的精确 `https://ark-proto.stardust.matce.cn/_release/<id>/public/vendor/preact.module.js` import。改变/删除 metadata 中的游戏 ID 而不匹配库内容会被拒绝；源 vendor 仍须逐字节匹配 lockfile/installed package 和已审查的单 import adapter。不同 game ID 使用分别准备的 immutable 静态 release（即使游戏美术相同），不能复用带另一 game ID hooks 补丁的目录。字体生成器保留 manifest 的 `/fonts/…` URL，但 CSS 内引用变为 `./filename`；准备器只允许 legacy/相对两种完整 reviewed hash，精确相对输入幂等，任意 drift 仍拒绝。生成的 global `game-static-locations.conf` 仍是 legacy 集成示例，rolling 接入不可盲目安装它覆盖 gateway/OpenI 路由。

## 门禁接入必须逐项验收

这里不更改/部署现有 Nginx 模板。首次接入须以实时 vhost 为基线合并，不能照搬仓库中目前写 3111 的旧模板来认定活动 resolver。具体约束：

1. `/entry`、登录、`/_gate/*`、认证 API 及 PRTS 基础资源仍由原服务拥有，不能转发给 gateway；gate bootstrap 不塞进游戏后端。
2. `GET /` 在现有 entry 准入/PRTS 流程后才交 gateway 重定向；不要把 `/` 的 302 当作已通过共享口令认证。
3. `/_release/…` 的 HTML、业务 JS/CSS、`data`、`shared`、`sim`、WS 和 bootstrap 统一保留 `auth_request`；`/_server/presence` 也必须保留门禁。不能因新前缀继承公开 `/assets` 的 `auth_request off`。
4. prefixed HTML 继续使用原来的 entry-nav/身份注入，注入脚本路径仍是稳定的 `/_gate/…`；前端的模块/资源路径则按页面 release prefix 固定。重连不应触发完整 PRTS 流程或自动回 current。
5. Nginx 向 gateway **覆写** Host/X-Real-IP；X-Real-IP 使用真实 `remote_addr`（如前面还有可信 CDN，先按正式 real_ip 链处理）。清空 CF-Connecting-IP；不能直接传客户端 supplied forwarding headers。gateway 只信 `trustedProxyAddresses` 中实际 TCP peer 的单个 X-Real-IP，忽略 XFF/CF/Forwarded，重新写入 backend 的可信原始地址；backend `TRUST_PROXY=auto` 才能继续执行公网 per-network quotas。不要设为 `0` 后声称还能限公网来源，也不要配置 trust 所有私网。
6. WS Origin 必须恰好匹配配置的 public origin/Host；Origin 不来自伪造的 forwarded-origin。保留升级头、足够的 WS read timeout 和现有 gate；gateway 不是公开 TCP 隧道，也不是独立密码验证器。
7. 明确禁止公开 `/control`、`/_material`、内部 health、管理 socket 目录及 state/config/registry 文件。匿名 root/prefixed HTML、代码/data/WS、presence 和 forged Origin 均须真实 Nginx 验收。

## 显式激活、回滚与退休

这些是**窗口授权后**由操作员运行的本地命令，不是预先安排自动发布：

```sh
node server/rolling/cli.js /run/ark-rolling/gateway.sock status
# 新代码/资源/backend准备验证完毕，registry加入新 immutableentry后
node server/rolling/cli.js /run/ark-rolling/gateway.sock reload
node server/rolling/cli.js /run/ark-rolling/gateway.sock activate game-r2
# 新入口回旧，两个版本的局仍继续
node server/rolling/cli.js /run/ark-rolling/gateway.sock rollback game-r1
node server/rolling/cli.js /run/ark-rolling/gateway.sock drain game-r2 on
node server/rolling/cli.js /run/ark-rolling/gateway.sock retire game-r2
```

Gateway UDS 命令为 `{op:'status'|'reload'}` 或 `{op:'activate'|'rollback'|'retire',releaseId}`；drain 另加 `draining:boolean`。只有 active 可以被显式 undrain。目标验证失败不会改 current；旧 private control 不可达时切换也拒绝，需先修复/核实，不以未知旧状态自动绕过准入。

retire **不是 stop**。先临时 fence 该 release 的新 HTTP/upgrade，再证明：非 active、backend reachable、draining、`canRetire=true`，`rooms=matches=queued=online=retainedSessions=0`，gateway 的 open/正在握手 WS tunnel 与 in-flight HTTP 都为 0。retainedSessions 包含 room/result/关闭通知的保留身份；保守的通知可能等到重连消费或 TTL。离线、roomless、无待交付游戏状态的普通身份不永久阻止退休；真人 live identity 必须先主动离开旧版。证明失败保持 routing，不杀人、不删除唯一游戏状态。

退休成功保存 tombstone，旧 URL 返回 410，backend 仍活着。只有操作员再次确认结果、残留进程与旧资源引用后，才能另行停止空 backend/解析器、清理资源；本工具没有 kill。静态 release 与 resolver 的保留期还要覆盖旧页面引用，不能只因房间数为 0 就立即删素材。retire 与新房间创建的安全依赖 backend drain fencing 和不可公开直连 backend，不能让另一个 admin 同时 undrain；同 UID 私有 admin 是部署信任边界。

## 在线人数与浏览器 contract

- `GET /_server/presence`（经过门禁）：`{online,queued,available,scope:'all-releases',serverNow}`。最多每秒刷新一次、并发 coalesce，只暴露聚合数值；各 backend 按完成 hello 的在线 session 去重、排除机器人。
- `available=false` 表示至少一个非 retired 后端不可达，online 只是已响应部分，UI 应显示不可用，不把它当完整人数。没有真实账户系统，不声称跨 idle 换版本可精确去重自然人。
- `GET /_release/<id>/_bootstrap`：`{releaseId,releaseBase,wsPath,currentReleaseId,currentReleaseBase,draining}`。`releaseBase` 含末尾 `/`，WS 是 `/_release/<id>/ws`；WS Token 在原协议 hello 中发送，不放 URL。
- canonical 页面是 `/_release/<id>/public/`：`public/{js,css,assets,media,fonts,vendor}` 代理 backend 对应根 mount；`shared/`、`data/` 位于 release 根；`server/sim/` 代理 backend `/sim/`，`server/data.js` 代理 `/data.js` shim。这保留实际文件树的相对 imports：`public/js/net.js` 的 `../../shared/…` 和 `server/sim/constants.js` 的 `../../shared/…` 都不会逃逸 release ID，content 的 `../../../data.js` 仍到 `server/data.js`。不能把页面放在 release 根后假定 URL 会像站点根一样 clamp 多余 `..`。
- `releaseBase/currentReleaseBase` 均指 canonical `/public/`，bootstrap 本身仍在 `/_release/<id>/_bootstrap`。旧 flat `/js`、`/sim` 等只是兼容代理 alias，不作为新客户端的模块入口。资源 helper/默认 WS 根据 release URL 定位；所有绝对业务/资源路径、importmap、sim/data shim、Spine/音频/font/vendor 需前端配套处理，由主助手实现/验收，本 backend 工作未编辑 public。

## 本地测试与剩余验收

```sh
node --test test/rolling.test.js
node --test deploy/stardust/openi-resolver/test/resolver.test.mjs
# 完整 canonical suite 要显式排除 deploy/build 旧导出app的重复发现。
```

### 本地候选部署接入（未激活）

`deploy/stardust/rolling/` 提供 **NEW 候选文件**，不覆盖当前 Compose/vhost：`compose.release.yaml` 为每个 immutable ID 建立独立游戏项目/镜像/loopback 端口（6 Worker、4096 默认房间上限、无游戏 CPU/内存硬限制，保留 pids128/只读/安全限制）；`compose.gateway.yaml` 复用新 app image，但命令为 `server/rolling/gateway.js`，使用 **host network** 访问后端宿主 loopback 映射。gateway 内部只绑定127.0.0.1，不能假设 bridge publish 能访问它。候选 gateway 3190 **不是**当前游戏3108；首次替换3108仍须另行获授权的空局维护。

`candidate.env.example` 与 `gateway.json.example` / `registry.json.example` 只给手工准备约定：镜像字段为空、manifestHash 为故意不能通过校验的占位，未固定 revision 前不能冒充 release。专用共享目录须手工建立为 UID1000/GID1000、0700，config/registry/state/socket0600，不自动建目录、不自动删 stale socket/kill/activate。`compose.sidecars.yaml` 单独准备带名字策略的 **新 auth image** 与带 `/_material` 的 **新 resolver image**；旧 v3 不可顶替。现有 auth/assets 服务仍独立，不接触当前3109/3110/3111。

`nginx-candidate.conf`、`nginx-entry-candidate.conf` 和 `nginx-legacy-assets-candidate.conf` 基于只读 live vhost（legacy resolver **3110 active**，非仓库3111模板），保留 TLS/CSP/门禁/入口注入/公开旧资源路由；canonical HTML 与其 index 保留 PRTS 重播，root 已播放 marker 只在校验后的 canonical Location 上传递，业务脚本/data/build/presence/WS 不公开，管理/health/material 根及前缀均拒绝。公开新资源走 per-release gateway registry，不把正常图片改为无条件宁夏回退。它不是现用配置，未来合并前必须重新读取 live policy，不能直接复制上线。

真实隔离集成测试（不安装系统包、不启动/重载宿主服务、不联系公网源）使用既有本地 Nginx binary、自签测试 TLS、固定 Node24 image 内两个独立真实游戏进程各6 Worker、独立 gateway 进程及 auth/真实 resolver；仅 OpenI 签名 API reply 注入 test-only 本地值，不跟随公网资源重定向。宿主 Node26 可以做编排，不冒称后端运行时也是26：

```sh
ROLLING_NGINX_SMOKE=1 NGINX_BIN="$LOCAL_NGINX" \
  node --test deploy/stardust/rolling/test/nginx.test.mjs
```

未显式 opt-in 或缺 Nginx 时真实 smoke 明确 skip，不能把配置字符串单测冒称实机验收。此测试不代替主助手的真实浏览器 PRTS 视觉/游戏资源渲染验收。当前优先级仍是完成 sync/整批回归与其他发布接入后再主线程 CPU profile/实际减负，**不部署、不重启、不切绿素材**。

专项测试使用两个真实 `startServer`/Match 后端和原生 gateway、真实 WS，不接触生产：cutover/rollback 现有 tunnel 和原 Match 保留；强断线/稳定 gateway 重启后旧 Token/playerId/room 重入；新 root；代码/本地测试资产/HEAD/Range/ETag/redirect 固定；未知/死旧版不 fallback；path/Origin/admin 拒绝；原始两个公网 IP 的 quota key；drain 和保留状态退休拒绝；manifest hot reload/immutable/tombstone/0600；OpenI 模式/身份/错误 fallback/不传凭据；metadata exact bytes 与 bridge health 拒绝。

还需主助手完成相同 Node 24 的整批 canonical 回归、真实双浏览器/多客户端验收、真实门禁/Nginx/资源重定向和最终上线前清单。通过 gateway localhost 测试不等于已验证生产门禁或已部署。运行内存压力和网关/后端故障测试只能在隔离本地服务；不得清理别人房间或在生产压测。
