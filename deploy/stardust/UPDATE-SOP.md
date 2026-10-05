# 游戏与静态资源协同更新 SOP

适用：ark-proto.stardust.matce.cn 游戏、独立 PRTS 门禁，以及 ark-asset.hanabi-ai.cn:25442 静态源。

正式源码目录为 `/root/projects/Stronghold-Protocol`，`origin` 为 Stardust-minus 的 fork、`upstream` 为原作者；本站 `master` 是集成分支。线上基线与仓库 HEAD 分开记录。0.1.2 + Worker 的历史发布单元见下方记录；此后每次更新都须配套验收及取得明确上线授权，提交、合并与推送不代表允许重启生产。

## 当前简单架构（2026-10-04 取消平滑更新）

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
3. `/assets`、`/fonts`、`/vendor` 对应的静态 release 目录、同 release 的 `/media/` 音频映射，以及文件/生成 Nginx include 的 SHA-256 清单。
4. 该版本的资源 manifest、package-lock、部署适配补丁及准备工具摘要。
5. 嘉兴 vhost 中上述四个资源路径指向的同一个静态 release。

历史 15:00 检查点（不是当前活动声明）：游戏源码 `2878299fb3b5e5b361177ed3e79e24efaab6d98e` / `0.1.2`，镜像 `ark-proto:v012-workers-20261004`，静态目录 `releases/v012-workers-20261004/`，6 Worker、maxRooms 4096（15:00 从初始 4 Worker 调整，未更换镜像或资源）。详见 `releases/v012-workers-20261004.json` 及 `releases/v012-workers-20261004-workers6.json`。上一完整回滚单元：`8cd6491e435f0a0355077b6162d1b17b77baa19e` / `0.1.1`、镜像 `ark-proto:8cd6491-20261003`、静态目录 `releases/8cd6491/`。

**不能只 git pull、只换游戏镜像，或只覆写素材目录。** 已上线的版本目录为 immutable，哪怕补丁只改一个字节，也应采用新目录后缀（例如 `<commit>-r2`），不要让长期缓存拿到同一 URL 的不同内容。

PRTS 是独立发布线：当前 HTML/动画仍是 spatial-06；基础库单独位于 `releases/prts-libs-20261004/`。游戏更新不自动改变 PRTS，除非其依赖或接口确实变化。用户要求 PRTS 前端由主助手直接实现，不委派前端实现。

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
  nginx/game-static-locations.conf     纯宁夏分流参考；不可覆盖正式 OpenI 路由
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

资源解析与游戏是独立发布线。只改变同字节素材的供应源时，只更新同 project 的 `ark-proto-assets` 服务并按需要 reload Nginx，不能顺带重建游戏。游戏版本升级时则必须协调切换新的游戏、宁夏 fallback、OpenI mirror 和解析清单；旧静态准备器生成的四路直跳模板不能盲目覆盖现用 `/assets/`、`/media/` 解析路由。上传/签名能力不涉及 fonts/vendor/PRTS 的搬回嘉兴，也不允许把账户 Token 部署到前端或公开日志。

## 四、预更新：只上传新版本，不改变线上

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
4. 在同一维护窗口中，将游戏镜像、素材解析器清单/OpenI 前缀、宁夏 fallback 和 fonts/vendor release 一起切到配套版本；若昵称策略同时更新，游戏与 auth 镜像也须包含同一份已验证策略。先确认全部新静态文件公网可用，再在同一 `ark-proto` project 内更新指定服务，不另起 release project。现有三个容器如仍带旧 project labels，clean 重建前必须备份 inspect 并确认仅替换这三个固定名字；不触碰 MySQL/OpenResty/其他站。不要在仍有旧对局时提前切换全局素材版本。
   `game-static-locations.conf` 是纯静态回退示例，不安装到现用 vhost；正式 `/assets/`、`/media/` 始终用 3130 OpenI resolver，root hooks 例外直接游戏，宁夏只承担字体/vendor/PRTS 与同版本故障回退。
5. 该方案不是跨主机原子事务，也不承诺旧客户端与新服务器混用兼容。需要通知客户端刷新，重新加载新业务代码/数据。仅协议版本号不变不能证明兼容。
6. 修改 Nginx 必须先 `nginx -t` 后 `nginx -s reload`。不要为了更新静态路由重启游戏或认证容器；真正升级游戏代码才重建游戏。
7. 除非 PRTS 本身发布，否则保留其独立基础库版本和 CSP，不改变密码、签名密钥或开场动画。
8. 当前三个服务Compose均无CPU/内存限额，D71已完成metadata统一；后续不能拿旧配置覆盖恢复限制。PIDs与安全选项保留，切换后同时核对Docker metadata和实际健康。游戏combat.ready仍为6，默认trial.ready为1，两个池分别检查。
9. 三个服务健康schema不同，禁止用all(health.ok)统判：game与auth要求HTTP200且ok:true；assets须在容器内部loopback访问/healthz，核对HTTP200、合法JSON及files等清单计数，不要求不存在的ok字段。宿主机经Docker端口转发访问assets健康可能因非容器loopback而404，不据此回滚。输出具体失败服务/状态/字段；不要重演D71首轮因schema误判而回滚的事故。

## 六、上线验收清单

- 游戏健康 app/image ID 与发布记录一致，三个容器 healthy，固定端口和单 project 正确；revision 由 OCI/image/发布清单核对，不新增运行时 release metadata。
- 新浏览器从正式游戏域名进入，PRTS WebGL/重播/昵称保留正常。
- 登录 HTML、CSRF、POST 授权和退出、游戏数据与代码不能因分流变成公开缓存；无效 Cookie、匿名代码请求仍被拒绝。
- 新静态 origin 只能提供公开资源，不含私钥、认证文件、源代码目录、上传接口。
- 字体/基础库/美术的最终 URL 指向正确 release；音频无扩展名请求的最终 URL 仍为同 release 的 `/media/<stem>`，不变成 `.mp3` 等后缀，且请求后缀入口的优先/回退行为与实际 MIME 一致；没有另一版本目录、404、MIME 或 CORS 错误。
- 按用户2026-10-05要求，auth片头与进入动画默认关闭，首次/已授权重入仍完成身份与CSRF/profile校验后直接进入；默认不加载Three/scene。用户显式勾选动画时保留PRTS效果，热缓存基础库命中正常；不要恢复旧的强制重播要求。
- 双人邀请、刷新重连、server 模式真实对局、棋盘与一次实际购买通过；只清理测试自己的房间。
- 留存浏览器结果、截图、文件清单、配置备份、切换时间和健康信息；不记录密码/Cookie/私钥。

## 七、回滚必须成对

若新版本失败：先判断是否已有新对局并获得相应授权，然后一起恢复**旧游戏镜像 + 旧 assets/fonts/vendor/media 重定向 release**（退回 0.1.1 时移除该版本不存在的 media 分流，不能指向新版音频）。只回滚其中一边会造成版本错配。回滚同样不能恢复已经因重启消失的对局。

如果只发生静态源故障且游戏版本没变，可以移除/禁用对应重定向，恢复游戏镜像中自带的同版本本地文件供给；PRTS 库则回到未改动的认证容器副本。只平滑重载 Nginx，无需重启游戏。

回滚时先读取现用配置，合并回退所需段落，不要用整份陈旧备份覆盖其他人的新改动。

## 八、保留与清理

- 至少保留当前和上一完整发布单元（包括已发布 immutable 静态/OpenI 目录）；正在供给或可能被旧页面继续引用的静态版本不删除。
- 上线完成后更新两台服务器上的运维说明与 release 清单，并明确哪些版本 active、哪些仅 staged。
- 定期检查磁盘、访问日志轮转、静态源响应码与两个源站的出口流量。
- 证书 2027-01-02 02:34:21 UTC 到期，当前为手动 DNS-01，没有自动续期。续期或 DNS API 委派需单独安排；不要把 A 记录或当次 TXT 值当作自动续期方案。

## 当前管理入口

嘉兴：`/opt/ark-proto/compose.yaml`、`/opt/1panel/www/conf.d/ark-proto.stardust.matce.cn.conf`。
宁夏：`/opt/ark-static/nginx.conf`、`/srv/ark-static/releases/`、`supervisorctl status ark-static`。
证书：宁夏 `/opt/ark-static/tls/`；管理机私有 ACME 备份 `/root/.local/share/ark-static-acme-20261004/`（含私钥，禁止公开或放进静态目录）。
