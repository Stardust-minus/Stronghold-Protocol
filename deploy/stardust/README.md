# Stardust 部署覆盖层

本目录版本化维护本站的认证/PRTS、Nginx、公开静态源和协同发布流程，不改变上游的项目目录结构。代码遵循仓库 GPL-3.0-or-later；第三方库按原许可证，游戏素材仍受根目录 NOTICE/THIRD-PARTY-NOTICES 的限制。

## 仓库与生产是两件事

- `origin`：`git@github.com:Stardust-minus/Stronghold-Protocol.git`。
- `upstream`：`git@github.com:sganggs/Stronghold-Protocol.git`。
- 本 fork 的 `master` 是本站集成分支；功能分支验证后合并，不强推或改写已发布历史。
- 固定本地工作目录：`/root/projects/Stronghold-Protocol`。旧 `/tmp` 工作目录只作历史参考，不再作为开发主目录。
- 历史 2026-10-04 15:00 检查点：已激活 `v012-workers-20261004`（上游 0.1.2 + 固定战斗 Worker 池 + `/media/` 静态适配），运行源码固定为 `2878299`。完整镜像/资源摘要和验收记录见 [发布记录](releases/v012-workers-20261004.json)；后续仅更新文档的 master 提交不代表运行镜像改变。上一版 `8cd6491` / `0.1.1` 保留供成对回滚。
- 15:00 +08 已按明确授权将 Worker 从 4 调到 6，镜像/资源未变；见 [运行配置记录](releases/v012-workers-20261004-workers6.json)。
- 实际激活状态以两机 release 记录为准。checkout、合并与推送不自动授权部署；须完成同一 commit 的本地验收并取得上线授权，才能协调切换游戏与静态路由。

## 当前部署：一个项目、三个服务

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
| `tools/openi-assets.py`、`OPENI.md` | 素材镜像上传/校验、无扩展名音频映射、签名缓存及无游戏重启的接入流程 |
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

禁止提交：真实密码、会话 Cookie、scrypt verifier/签名密钥、SSH/DNS API 凭据、私钥、证书、ACME 账户、日志、带用户信息的截图或生产数据导出。`.gitignore` 和 `.dockerignore` 是辅助，不替代提交前人工检查。

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
