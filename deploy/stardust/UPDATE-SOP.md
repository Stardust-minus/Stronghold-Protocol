# 游戏与静态资源协同更新 SOP

适用：ark-proto.stardust.matce.cn 游戏、独立 PRTS 门禁，以及 ark-asset.hanabi-ai.cn:25442 静态源。

正式源码目录为 `/root/projects/Stronghold-Protocol`，`origin` 为 Stardust-minus 的 fork、`upstream` 为原作者；本站 `master` 是集成分支。线上基线与仓库 HEAD 分开记录。0.1.2 + Worker 的历史发布单元见下方记录；此后每次更新都须配套验收及取得明确上线授权，提交、合并与推送不代表允许重启生产。

## 杭州/Beta准备与正式切换分开

用户2026-10-06要求先准备独立杭州Beta和版本化业务JS/CSS本地供给，详 [BETA-SOP.md](BETA-SOP.md)。Beta拥有独立backend/会话/门禁签名/Origin/vhost，不能把Beta域名指向正式进程或绕过密码门禁。更大的12+2 Worker与`beta`/`core`宿主profile均须逐池及实际线程核对，原`prod`仍6+1。WG发布端口涉及Docker DNAT/FORWARD，精确隔离及重建fail-closed不可只用INPUT/绑定地址代替。

正式更新+服务器切换只留UTC+8每天05:00–08:00低谷并取得具体执行指令；本地测试、Beta上线、提交推送、用户睡觉或时间到窗口都不是自动正式激活许可。以下旧单机步骤不能直接在新机照搬；保留现用配置并按实际目标合并，配套材料与回退仍遵循本SOP。

## 最新素材供应源切换：ModelScope60 / OpenI40（2026-10-06 17:19）

本批正式公开 `/assets/`、`/media/` 普通GET于17:12:58+08激活、17:19:54+08验收为ModelScope60/OpenI40/宁夏0，按请求随机选择，缓存302可复用所选源。宁夏HEAD及原OpenI故障fallback、fonts/vendor/PRTS保持，Beta分流未变。配套静态仍为C1 `v013-hangzhou-20261006-1f742992`，game7e019ee/image10c94333/CID8715f3a3，resolver063/image53ac、auth186均未更换；只有宿主Nginx/Lua与平滑reload，无容器/WG/管理器重启。

当前正式vhostSHA `cefc036ffbf804c96294b66837a564f5e731172e8e40c897c903a270bbf68e06`，global397db9bc/Beta4c8fb2d5不变。ModelScope `Stardust/arknight-assets` 的immutable前缀 `releases/v013-modelscope-20261006-1f742992-174200` 固定revision `34fa98b056c7554b8dbea7a4e18e78b6c6445fbb`；7200对象/7049唯一内容SHA/403852758字节/24968aliases，全量本地hash与远端LFS SHA/size库存核对，不等于全量正文重下载。provider生成的.gitattributes扩展单独审计，8个旧文件保持。实际Chrome匿名混合来源hash、audio、Spine1053pixels通过，本批无密码输入或玩法验收。

具体实现、短缓存和回退边界见 [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md) 及 [活动记录](releases/v013-material-lb-20261006-modelscope60-openi40.json)。[access.lua](material-lb/access.lua)/[header.lua](material-lb/header.lua)、离线 [prepare-material-lb.py](tools/prepare-material-lb.py) 和 [test-prepare-material-lb.py](tools/test-prepare-material-lb.py) 仅当前C1/pin/60:40 profile，无上传/自动激活或通用provider env-switch。ModelScope先跳稳定pinned resolve入口再由provider到CDN，不套用auth_key TTL，也不保证所有下游CDN错误自动fallback。

公开已知302的max-age<=60；OpenI另受Expires-now-30限制，只接受固定sp_request=cors|display，已知OPTIONS204保持、公开错误/OPTIONS no-store、私有门禁/no-store不变。目标OpenResty add_header在Lua之后：公开location重复原HSTS/nosniff/frame/referrer/CSP，却不继承或追加Lua管理的CC/CORS/Vary，以免重复头或漏掉安全头。

**未来游戏release必须重审并匹配所有活动源、alias与fallback；不能复用当前锁定profile切新素材。** 固定源码/镜像、host配置SHA与记录提交的Git HEAD分开。本次用户请求推送不授权任何后续live操作；下一次权重、Beta接入或新材料切换仍需具体执行授权。下面的WS批和更早记录是对应时间快照，已完成one-shot不得重跑。

## 当前游戏版本的历史激活：WS 压缩（2026-10-06 14:30）

正式当前source `7e019ee36a2423393221cbba37bf60e40be35536`，实际HGY image10c94333/CID8715f3a3，记录 `releases/v013-ws-compression-20261006-7e019ee3-r2.json`。用户明确批准本批立即维护重建，不产生今后任意时刻重启的通用许可。Beta仍为C1/1f742992且代次未变。

`SP_WS_COMPRESSION=on` 在fixed runtime.env中显式启用，Compose从同变量注入；默认off。参数、类型白名单、凭证不压缩及回退边界见 [WS-COMPRESSION.md](WS-COMPRESSION.md)。12+2、Main-only优先级、UV默认4、WG启动链不变；不能restart WG来更新游戏。

此批仅四个server blobs及announcements数据变化。232game-runtime Git字节及完整C1基础RootFS核验后，复用同字节C1私有JS/CSS/shared/package/static；Auth186、resolver063、现用OpenI/宁夏素材不重建或上传，Nginx也未reload。Remote COPY元数据导致新增层与local不同，记录的是完整已验证base+精确五文件层及全部game-runtime字节证明，不能冒称整个新RootFS等于local。

以下10:32迁移记录是当时快照，不是当前game版本声明。

## 历史正式迁移：杭州计算 / 嘉兴入口（2026-10-06）

实际活动记录：`releases/v013-hangzhou-20261006-1f742992.json`。10:32:42+08正式路由迁杭州，10:48:54旧嘉兴计算停止；旧镜像/容器/配置/资源保留。不要复用下面历史嘉兴三服务的一次性activation。

- 杭州 `/opt/ark-proto/compose.core-game.yaml` + `runtime.env`，固定profile `core`，12combat+2trial，Main-only-20/reset/其他0；`ark-core-game-backend.service` 按关闭护栏→Compose→优先级→精确WG租约启动并监测。
- 嘉兴 `/opt/ark-proto/compose.yaml` 是edge-only auth/assets；正式vhost只有一个 `10.253.77.2:3120` backend。私有代码供给按固定commit+门禁，与同版本core fallback配套。
- 游戏source1f74299，解析器source0635506，auth仍source186，三个组件分别固定；不能说它们都等于最新Git HEAD。当前素材v013-hangzhou-20261006-1f742992，OpenI新音频与已验证同字节旧素材通过最多两个明确mirror ID复用。
- 11:28 Beta已同步同一1f74299游戏及配套私有代码/素材/解析器；Beta auth保持源B4（与C1字节相同），不改口令/签名key。重复Beta浏览器/玩法验收由用户明确要求跳过，组件就绪检查仍完成。见 `releases/v013-beta-sync-20261006-1f742992-r2.json`。
- 11:42两端WG恢复e6087bf已安装、active/exited并enable；杭州core/Beta管理器采用WG Requires/After drop-in并enable，现有管理器和游戏代次未变。180项Python和6项隔离真实内核测试、现网只读幂等通过；未做共享主机实际重启测试。不要停止/restart WG恢复单元，Requires可能连带停止游戏。详 `WG-BOOT-RECOVERY.md`。
- 当时嘉兴全局variables_hash_max_size2048、两game上游HTTPidle4s；WS3600s、门禁/TLS/单upstream保持。11:42时正式vhostSHA5e123d68…、迁移激活时5b01be43…均为历史；最新素材切换后是上方cefc036f…。仅可选WebP后置，不为它再重启正式。
- 回滚需先读现用配置，恢复旧嘉兴同配套版本并验证6+1/仅Main-20，再恢复旧单upstream/私有代码/素材映射；回滚不会恢复已丢内存对局。不整表恢复nft，不停其他服务。

## 历史简单架构（2026-10-04 取消平滑更新）

- 只有一个 Compose project `ark-proto`、三个固定服务/容器：游戏 `ark-proto`（127.0.0.1:3120）、门禁 `ark-proto-auth`（3141）、素材解析器 `ark-proto-assets`（3130）。Nginx 直接接游戏，普通入口 `/`、WebSocket `/ws`；不再运行网关、备用游戏实例或蓝绿素材槽位。
- `compose.yaml` 是完整视图；`compose.auth.yaml` / `compose.assets.yaml` 是同 project、同 service key/container_name 的服务专用视图，不是另一个项目。使用同一份 `runtime.env`，只更新对应服务，禁止为更新创建第四个服务。
- 三个服务均不配置 CPU/内存硬限额；游戏保持6个正式combat Worker、maxRooms4096，保留PIDs、只读与安全选项。D71 / v012-simple 已在2026-10-04 23:45 +08统一重建，metadata CPU/内存为0、project为ark-proto；每次仍须实时inspect确认。0.1.3新模板另外显式配置SP_TRIAL_WORKERS=1（可0/1/2），是进程内独立试算线程，不增加服务/后端。
- `/_release/v012-alliance-20261004/` 仅是已打开页面的临时兼容路径：HTML 302 到 `/`，代码和 WS 仍接同一个游戏。未知 prefix 404，不再创建新的游戏 release URL；`/_server/presence` 仅由 Nginx 内部读取单后端健康并输出聚合人数，不暴露健康详情。
- 游戏重建会丢失内存中的房间/对局/会话；没有平滑迁移、drain、私有控制 socket 或跨版本恢复。保持游戏在线时的普通断线重连不受此代码清理影响。
- 此文档说明获授权发布的操作要求，不代表任何本地工作树已经部署；每次以固定commit、实时配置和验收后的release记录为准。

## 一、发布单元与不可违反的边界

一次游戏发布必须同时记录并核对：

1. 固定的本站 fork 完整 commit，以及其包含的上游基线 commit（不使用会继续变化的分支名作为上线标识）。
2. 由该 commit 构建的游戏镜像标签和镜像 ID。
3. `/assets`、`/fonts`、`/vendor` 的宁夏静态release、同release `/media/`音频alias，以及文件/生成Nginx include的SHA-256；同时记录活动OpenI镜像清单、ModelScope immutable prefix和40hex revision、各源对象/alias内容一致性。
4. 该版本的资源manifest、package-lock、部署适配补丁、准备工具与宿主Lua/路由数据摘要；实际运行game/sourceHash和组件revision与文档Git HEAD分别记录。
5. 嘉兴vhost中四个资源路径的匹配关系：fonts/vendor仍宁夏，assets/media可以不同provider前缀，但须指向**同配套release的已验证同字节文件与精确alias**，不能只凭同名目录或源站比例认定匹配。

历史 15:00 检查点（不是当前活动声明）：游戏源码 `2878299fb3b5e5b361177ed3e79e24efaab6d98e` / `0.1.2`，镜像 `ark-proto:v012-workers-20261004`，静态目录 `releases/v012-workers-20261004/`，6 Worker、maxRooms 4096（15:00 从初始 4 Worker 调整，未更换镜像或资源）。详见 `releases/v012-workers-20261004.json` 及 `releases/v012-workers-20261004-workers6.json`。上一完整回滚单元：`8cd6491e435f0a0355077b6162d1b17b77baa19e` / `0.1.1`、镜像 `ark-proto:8cd6491-20261003`、静态目录 `releases/8cd6491/`。

**不能只 git pull、只换游戏镜像，或只覆写素材目录。** 已上线的版本目录为 immutable，哪怕补丁只改一个字节，也应采用新目录后缀（例如 `<commit>-r2`），不要让长期缓存拿到同一 URL 的不同内容。

PRTS 是独立发布线：本次片头开关修正的HTML/脚本标记为spatial-07，业务脚本URL带对应版本参数，避免旧的一小时缓存继续关闭进入转场；基础库仍单独位于 `releases/prts-libs-20261004/`。游戏更新不自动改变 PRTS，除非其依赖或接口确实变化。用户要求 PRTS 前端由主助手直接实现，不委派前端实现。

## 二、联网本机准备，不在嘉兴运行下载和测试

1. 在正式仓库 fetch upstream/master，在独立同步分支合并并记录原作者与本站两个完整 commit、提交时间和与线上版本的 diff。保留旧工作树及部署补丁，不在旧目录强制 reset；合并通过后才进入本站 master。
   特别审查新增静态路由，例如 8cd6491 之后上游增加的 `/media/` 无扩展名音频路径：上线前必须同步适配分流和测试，不能只复制旧 `/assets/` 配置。
2. 从固定 commit 导出全新源码。package-lock 若变化，必须按新 lock 安装依赖并生成 vendor；不能继续复用旧 node_modules/vendor。无变化时也需验证复用文件哈希。
3. 保留去 Google Fonts 外链适配，不改变 `SP_COMBAT=server`、`SP_VERIFY=off`、密码或 PRTS 接口。
4. 素材以新 commit 的 manifest 为准。整合包可以提供素材，但不能用旧包覆盖新源码；校验发行包摘要，确认 manifest 匹配并检查所有引用文件存在且非空。新版游戏代码、数据、前端库和素材必须配套。
5. 构建游戏镜像并固定 OCI revision 标签；测试采用与生产一致的 Node 运行时。未来若更新 Node 基础镜像，也要记录完整摘要。
6. 运行完整测试，并启动隔离的真实游戏做双浏览器入房、重连、开始模拟、准备阶段、棋盘、购买干员和 Spine 载入验收。单元测试通过不等于线上能运行。

原始完整材料工作区：`/tmp/ark-prestage-v0.1.1-20261003/`。它是本轮工作目录，不保证跨管理机重启保留；远端保存了游戏镜像归档，静态机保存了素材归档、清单与运行文件。

## 三、静态分发适配与一致性清单

游戏静态 release 应包含：

```text
releases/<release>/
  assets/    美术、音频、模型、棋盘及其配套文件
  fonts/     字体及 fonts.css
  vendor/    由该版本 lockfile 产生的第三方库
```

当前明确的分发适配（仅修改新静态副本，必须记录补丁及修改后哈希）：

- `fonts/fonts.css`：新生成器直接输出 `url('./…')`；原始 manifest URL 仍为 `/fonts/…`。准备器只接受两种已审查的完整六-URL CSS 摘要：legacy 根路径输入会转换，新相对路径输入精确幂等。不会因为任意 CSS 看起来是相对 URL 就放行；跨域后按 CSS 最终 URL 找字体。
- `vendor/hooks.module.js`：普通 immutable 静态副本的唯一 import 固定为 `https://ark-proto.stardust.matce.cn/vendor/preact.module.js`；正常 root 路由的 hooks 小型 sibling-import adapter **直接取游戏镜像原件**，其 `./preact.module.js` 与主游戏请求身份一致。其余 vendor/字体正文仍由匹配的宁夏 release 供给。已发布旧静态目录的 prefix 适配只是历史兼容，不覆写它，也不再生成 prefix hooks。
- `/media/`：嘉兴只重定向到新 release 的 `/media/`，宁夏用准备时生成的精确文件 alias 供给正文。**客户端请求的无扩展名 URL 最终仍无扩展名**，不得再次重定向到 `.mp3` 等后缀。每个音频 stem 同时生成 `shared/media.js` 的 `AUDIO_EXTS` 所列后缀入口：请求后缀有文件时优先该文件，否则按共享扩展名顺序回退；Content-Type 始终由实际选中文件决定。不是开放任意路径/任意扩展名的文件解析器，也不另建一份音频目录。
- 不盲目批量替换所有字符串或 URL。上游若调整 import 结构，现有适配条件不匹配时停止，重新分析并浏览器验收；不能忽略失败继续发布。
- Three.js 的相对 module/core 引用以及字体 CORS 必须验收。当前公开静态源按用户要求使用 Access-Control-Allow-Origin: *，不启用 Allow-Credentials；还应从无关站点测试匿名 fetch、字体和 Canvas 读取。此设置不代表当前 Preact 适配版 vendor 对所有第三方站点通用。任何 import path 补丁都是发布单元的一部分，不是可丢失的临时修改。
- `gate.js`、`gate.css`、`scene.js`、`entry-nav.js`、登录 HTML、游戏业务 JS/CSS、data、认证接口不放到公开静态源。PRTS 只迁移 Three.js/Core/CSS3D 和字体，不改变页面动作与授权流程。

每个静态文件记录相对路径、字节数、SHA-256。清单保存在 `/opt/ark-static/` 运维目录，不需要对外开放。上传后在宁夏重新逐文件校验，不以 scp 退出码代替完整性校验。

0.1.1 基线参考清单：`asset-manifest.json`、`stable-manifest.json`、`vendor-manifest.json`。新工具使用下述 `release-manifest.json` / `SHA256SUMS`；不要混淆不同发布单元的清单。归档只允许预期路径，拒绝软链接、硬链接和路径穿越。

### 离线准备工具与新清单

`deploy/stardust/tools/prepare-static-release.mjs` 不联网、不改源文件、不激活 release。`APP_EXPORT` 必须是与新游戏镜像相同的固定 app 导出目录，包含已核对的本地依赖/vendor/素材；`SOURCE_REVISION` 为该源码完整 40 位 commit。工具记录调用方提供的 revision 和输入摘要，**不能把带未提交改动的 checkout 自动证明为该 commit**。`STAGE` 必须是不存在的新目录，已有目录（即使为空）也拒绝覆盖。仓库内输出仅允许放在已忽略的 `deploy/stardust/build/` 下。

```sh
# STATIC_RELEASE 必须使用新 immutable ID；v012-workers-20261004 和 v012-alliance-20261004 已发布，不能复用/覆盖。
node deploy/stardust/tools/prepare-static-release.mjs \
  --source "$APP_EXPORT" --revision "$SOURCE_REVISION" \
  --release "$STATIC_RELEASE" --out "$STAGE"
node deploy/stardust/tools/prepare-static-release.mjs --verify "$STAGE"
```

工具先校验 manifest 中所有本地资源存在且非空，核对 package/package-lock、已安装依赖版本/lock integrity 和 vendor 源文件字节。公开副本仅来自 assets/fonts/vendor：拒绝未知字体、未知 vendor、assets 中的业务代码、点路径、软/硬链接及非普通文件；不会复制 public/js、业务 CSS、data 或认证目录。两个补丁 fail closed：fonts.css 必须匹配已审查的 legacy 或精确相对路径六 URL 模板摘要；hooks 必须是唯一的已知 Preact import，固定导向 root 游戏 origin 的 `/vendor/preact.module.js`。若上游变动导致条件失败，重新审查适配器，不能跳过校验。

生成目录：

```text
<STAGE>/
  releases/<release>/{assets,fonts,vendor}/
  release-manifest.json                 运维元数据，不放到公开资源前缀
  SHA256SUMS                           同时覆盖资源和下面四个 include
  nginx/static-cache.conf              加到静态源的 $asset_cache map 中
  nginx/static-files.conf              加到静态源 http 中（精确 URI 清单）
  nginx/static-locations.conf          加到静态源 TLS server 中
  nginx/game-static-locations.conf     纯宁夏分流参考；不可覆盖正式多源Lua/OpenI路由
```

清单 `schemaVersion: 1` 记录 release/sourceRevision/appVersion、准备器 SHA-256、源输入摘要、补丁前后摘要、共享音频 prefix/扩展名顺序、每个公开文件的 path/bytes/SHA-256、每个音频 URL 的 requestedExtension/实际文件/实际 MIME，以及四个 include 的摘要。`--verify` 校验精确库存（额外文件也拒绝）、文件哈希、音频映射和生成配置，并验证字体是精确已审查相对输出、hooks 的唯一原始 import URL 与 root 游戏地址一致。清单与配置不放入 `/srv/ark-static/releases/<release>/{assets,fonts,vendor}/`；精确 URI whitelist 即使目录中误入其他文件也不对外供给。

本地测试：

```sh
node --test deploy/stardust/tools/prepare-static-release.test.mjs
# 可选：使用已有 Nginx，不安装/启动系统服务；临时配置、PID、temp 和监听都隔离。
NGINX_BIN="$LOCAL_NGINX" NGINX_MIME_TYPES="$LOCAL_MIME_TYPES" \
  NGINX_RELEASE_DIR="$STAGE" \
  node --test deploy/stardust/tools/prepare-static-release.test.mjs
```

完整 smoke 的 STAGE 及其父路径必须可被 Nginx worker 遍历读取（例如使用 `/tmp` 下的本地测试目录，不使用私有 `/root` 父路径）。测试遍历每个文件和音频 alias，另测 MIME、HEAD、Range/If-Range、ETag/304、CORS、错误/成功缓存和隐藏文件/路径穿越/软链接拒绝。无 Nginx 时相关 smoke 明确 skip，不以 unit 测试替代真实路由验收。已用 Nginx 1.28.3 验证 5,529 文件、536 stem + 3,752 后缀 alias；这是本地验证记录，**不是生产状态声明**。

静态配置需保留已测试的 `map_hash_bucket_size 512` / `map_hash_max_size 8192`，否则完整长路径库存可在 `nginx -t` 时失败或报警。`$asset_cache` map 的 `volatile` 也必须保留：Range filter 可能在初次 200 headers 后产生 416；重新求值确保最终带 `no-store`（其优先级高于此前已追加的 immutable/max-age）。普通 403/404 则只带 no-store。`$asset_cors_origin` 状态 map 同样不能省略：该静态 Range 416 保留初次 CORS header，因此第二次 filter 不再追加 ACAO，避免 `*, *` 导致浏览器拒绝 CORS；其他正常/错误响应仍提供单个 `*`。

### OpenI 素材镜像接点

启用 OpenI 签名解析后，宁夏仍是完整回退源及 fonts/vendor/PRTS 的正文源，不能省略上述准备。另按 `OPENI.md` 上传同一批已校验的 assets 到新 immutable mirror 前缀，生成/验证同版本 resolver manifest；音频远端名保持无扩展名。记录解析器代码/镜像 ID、清单 SHA-256、平台前缀和 fallback release。

资源解析与游戏是独立发布线。只改变同字节素材供应源时，按实际改动仅安装新的宿主profile并平滑reload Nginx；只有解析器代码/挂载确实变化且另获授权才更新同project的 `ark-proto-assets`，不能惯例重建resolver或顺带重建游戏。本批resolver/auth都未重启。游戏版本升级时必须配套新游戏、宁夏fallback、OpenI mirror/清单，以及所有活动ModelScope pin/alias和host Lua数据；旧四路直跳模板不能覆盖现用多源路由。供给边界见 [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md)，不搬回fonts/vendor/PRTS正文，不在前端/serving config部署账户Token。

## 四、预更新：只上传新版本，不改变线上

下列涉及嘉兴game/三服务重建的步骤源于旧单机基线；当前正式计算在杭州，嘉兴为edge。未来发布先核对实际core/edge/Beta Compose、独立组件revision及WG/管理器依赖，再按对应角色合并实施，不把旧单机示例当one-shot执行。本批同字节分流不需任何容器重建。

1. 将游戏镜像导入嘉兴的新标签，不修改现用 Compose。
2. 将新静态文件上传宁夏的**新目录**，不要覆盖旧版本文件。将整个 STAGE 先放到非公开的运维 staging 目录，在该目录运行 `sha256sum -c SHA256SUMS`；校验成功后才将 `releases/<release>/` 安放到 `/srv/ark-static/releases/`。归档路径/链接安全检查仍需单独完成，不能只校验哈希。
3. 为新版本安装生成 include：`static-cache.conf → /opt/ark-static/generated/cache/<release>.conf`、`static-files.conf → generated/http/<release>.conf`、`static-locations.conf → generated/locations/<release>.conf`。将已审查的新 `static/nginx.conf` 接入这些可选 globs（并保留现用 TLS、端口、PRTS 和旧 release），先 `nginx -t -c /opt/ark-static/nginx.conf`，无 hash 警告后再平滑 reload。嘉兴的 game include 暂不接入，避免提前切全局素材版本。
4. 通过公网 `https://ark-asset.hanabi-ai.cn:25442` 验证：正常 TLS、200/HEAD、Content-Type、CORS、ETag/304、音频 Range/206、错误 no-store、成功 immutable、不能列目录、无代码/秘密文件泄露。
5. 对测试浏览器模拟完整重定向和 CSP，检查实际图形渲染、Spine 配套 SKEL/ATLAS/PNG、OBJ/JSON、音频、字体、Preact hooks 及重复打开时 Three.js 命中缓存。
6. 记录线上游戏/认证容器 ID、PID、StartedAt、restart count，现用 Compose 和 vhost 哈希。预更新结束前再次比对，确认没有动到运行进程。

`3000 → 36.103.203.216:25442` 是平台唯一入站映射，不要改为假定 80/443 可用。新机不依赖 systemd，Nginx 由现有 Supervisor 的独立 `ark-static` 程序管理。

## 五、实际上线：在明确窗口协调切换

1. 用户确认上线后，重新读健康接口与当前配置，不依赖之前保存的对局数量。
2. 正常情况等待无进行中对局并协调在线玩家。只有用户明确要求立即切换并接受清除对局时才例外；记录切换前房间、对局和连接数量。对局在内存中，不能在线迁移或通过镜像回滚恢复。
3. 备份当时的三服务 Compose/runtime.env、vhost、两个正常 snippet、认证配置及运维说明，记录旧镜像与旧静态前缀。
4. 在明确维护窗口内协调游戏镜像、OpenI清单/前缀、活动ModelScope revision/prefix及host Lua/alias数据、宁夏fallback与fonts/vendor到同一配套单元；若昵称策略变化，game/auth也须匹配。先证明全部材料公网可用，再按实际杭州core/嘉兴edge/Beta角色更新获授权的指定组件，不另起release project或照旧三服务整批重建；未改组件保持其镜像与代次。clean重建前备份inspect并核对确切目标，不触碰MySQL/OpenResty/其他站。不要在旧对局仍运行时提前切换全局素材版本。
   `game-static-locations.conf`是纯静态参考，不覆盖现用vhost；正式 `/assets/`、`/media/`当前由宿主Lua选择ModelScope60/OpenI40，OpenI分支才继续3130原resolver。HEAD/原故障fallback及字体/vendor/PRTS仍宁夏，root hooks直接游戏。新release须先更新所有精确白名单/pin/数据并验证，不能把当前固定C1模板当通用开关。
5. 该方案不是跨主机原子事务，也不承诺旧客户端与新服务器混用兼容。需要通知客户端刷新，重新加载新业务代码/数据。仅协议版本号不变不能证明兼容。
6. 修改 Nginx 必须先 `nginx -t` 后 `nginx -s reload`。不要为了更新静态路由重启游戏或认证容器；真正升级游戏代码才重建游戏。
7. 除非 PRTS 本身发布，否则保留其独立基础库版本和 CSP，不改变密码、签名密钥或开场动画。
8. 当前game/auth/resolver均无CPU/内存限额，不能用旧配置恢复限制。PIDs/安全选项保留，核对Docker metadata及逐组件健康。Worker池按实际目标profile分别核查：现用杭州正式/Beta为combat12/trial2；历史嘉兴及默认模板6+1不代表当前池数。
9. 三个服务健康schema不同，禁止用all(health.ok)统判：game与auth要求HTTP200且ok:true；assets须在容器内部loopback访问/healthz，核对HTTP200、合法JSON及files等清单计数，不要求不存在的ok字段。宿主机经Docker端口转发访问assets健康可能因非容器loopback而404，不据此回滚。输出具体失败服务/状态/字段；不要重演D71首轮因schema误判而回滚的事故。
10. MainThread默认仅nice=-20的宿主策略按 [MAIN-THREAD-PRIORITY.md](MAIN-THREAD-PRIORITY.md) 固定commit/hash核对，**不混入游戏app或公开素材**。当前杭州已安装且本批只读确认，不能因推送或素材切源重新安装/reapply。未来游戏升级或回滚须在明确授权窗口核对实际revision/image ID白名单，真正Node主TID、普通SCHED_OTHER/reset-on-fork、Main=-20、其余线程0及profile对应池数。不给容器加CAP或包nice入口；策略工具失败不自行重启游戏，WG Requires依赖不能顺带restart。

## 六、上线验收清单

- 游戏健康 app/image ID 与发布记录一致，三个容器 healthy，固定端口和单 project 正确；revision 由 OCI/image/发布清单核对，不新增运行时 release metadata。
- 新浏览器从正式游戏域名进入，PRTS WebGL/重播/昵称保留正常。
- 登录 HTML、CSRF、POST 授权和退出、游戏数据与代码不能因分流变成公开缓存；无效 Cookie、匿名代码请求仍被拒绝。
- 新静态 origin 只能提供公开资源，不含私钥、认证文件、源代码目录、上传接口。
- 字体/基础库/美术指向匹配release；多provider跳转须核对稳定ModelScope revision/prefix、OpenI清单对象和宁夏fallback的同字节哈希/alias，不要求不同CDN有相同目录拼法。音频无扩展名入口保留，各源精确映射同一选定对象，不变成.mp3等后缀；实际MIME/Range/AudioContext、完整Spine和浏览器CORS需验收，不能以库存校验代替正文/渲染。检查单Cache-Control、单CORS*、VaryOrigin/Sec-Fetch-Mode、已知OPTIONS204及私有门禁未变。
- 按用户2026-10-05更正，仅auth片头默认关闭；登录界面组装、WebGL/界面动效、成功凭证和进入转场仍保留，首次/已授权重入都先做真实身份与CSRF/profile校验。`ark.prts.intro`只控制片头，旧全局0偏好不能继续禁用其他动画；减少动画偏好/立即进入兜底仍有效。检查新gate.js版本化URL，不能被旧缓存变成一闪跳过。
- 双人邀请、刷新重连、server 模式真实对局、棋盘与一次实际购买通过；只清理测试自己的房间。
- 留存浏览器结果、截图、文件清单、配置备份、切换时间和健康信息；不记录密码/Cookie/私钥。

## 七、回滚必须成对

若新版本失败：先判断是否已有新对局并获得相应授权，然后一起恢复**旧游戏镜像 + 旧assets/fonts/vendor/media配套release + 对应OpenI清单/ModelScope pin/host Lua及alias数据**（退回0.1.1时移除该版本不存在的media分流）。只回滚其中一边会造成版本错配，回滚不能恢复因重启消失的内存对局。若只是本批同字节供应源故障，按 [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md) 合并当前公开location回到原direct-OpenI或获授权的同版本宁夏形态，仅平滑reload，不重启游戏。

如果只发生静态源故障且游戏版本没变，可以移除/禁用对应重定向，恢复游戏镜像中自带的同版本本地文件供给；PRTS 库则回到未改动的认证容器副本。只平滑重载 Nginx，无需重启游戏。

回滚时先读取现用配置，合并回退所需段落，不要用整份陈旧备份覆盖其他人的新改动。

## 八、保留与清理

- 至少保留当前和上一完整发布单元（含immutable静态/OpenI/ModelScope前缀、固定revision、host profile与私有备份）；正在供给或可能被旧页面引用的版本不删除。旧release JSON保持历史，不因最新LB改写旧记录。
- 上线完成后更新两台服务器上的运维说明与 release 清单，并明确哪些版本 active、哪些仅 staged。
- 定期检查磁盘、日志轮转、活动provider响应码与出口流量；不记录/提交签名URL query、Token、Cookie、密码、SSH/DNS凭据、verifier、证书/私钥、素材/vendor正文或日志内容。自然观察不是生产压力测试或新激活许可。
- 证书 2027-01-02 02:34:21 UTC 到期，当前为手动 DNS-01，没有自动续期。续期或 DNS API 委派需单独安排；不要把 A 记录或当次 TXT 值当作自动续期方案。

## 当前管理入口

嘉兴：`/opt/ark-proto/compose.yaml`、`/opt/1panel/www/conf.d/ark-proto.stardust.matce.cn.conf`。
宁夏：`/opt/ark-static/nginx.conf`、`/srv/ark-static/releases/`、`supervisorctl status ark-static`。
证书：宁夏 `/opt/ark-static/tls/`；管理机私有 ACME 备份 `/root/.local/share/ark-static-acme-20261004/`（含私钥，禁止公开或放进静态目录）。
