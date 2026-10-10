# 游戏与静态资源协同更新 SOP

适用于部署者自己的 game、独立 auth/PRTS、resolver、入口代理与公开静态源。示例 origin 为 `https://game.example.com` 和 `https://assets.example.com`，部署路径用 `<占位符>`；不是站点运行状态或执行授权。集群与独立 Beta 分别补充遵循 [CLUSTER-SOP.md](CLUSTER-SOP.md)、[BETA-SOP.md](BETA-SOP.md) 及 [双 ingress 合同](cluster/DUAL-INGRESS.md)。

## 一、权限与发布单元

**提交/推送、测试通过、素材上传、镜像准备、Beta 发布、用户离线或到达约定窗口都不授权正式切换。** 每次取得具体环境、组件、维护影响与执行窗口的用户授权；DNS、秘密轮换、管理通道、WG、清理和其他服务另行判断。已消费的一次性控制器不得重放；中断后先读取实际阶段状态与身份，不因本地提示中断而重复激活。

一次配套发布至少绑定：

1. 完整源码 commit 与已合并的上游基线；若使用 tree 身份，明确 source-kind 和内容摘要，不能冒称 Git commit。记录 HEAD 与运行 revision 分开。
2. 固定基础镜像 digest、game 的 immutable image ID/OCI labels，以及 source/resource manifest 摘要。不同 Docker store 的 ID 若不同，需独立核对 RootFS/labels/内容，不能只比标签名。
3. lockfile、已准备依赖/vendor、资源 manifest、ignored generated renderer index 与私有 JS/CSS 的精确文件/URL 清单。
4. 新 immutable 静态 release、音频 `/media/` alias、fonts/vendor/PRTS 的独立版本；所有活动 OpenI mirrors、ModelScope immutable prefix/固定 revision 和同版本 fallback 的 path/bytes/SHA-256 对应关系。
5. resolver 代码/镜像与挂载清单、宿主 Lua/JSON profile、Nginx includes/vhost、Compose/runtime、host policy/工具版本及回滚单元。未改组件单独保留身份，不惯例重建。

**不能只 git pull、只换 game 镜像或覆写素材目录。** 已供给目录 immutable，一个字节变化也使用新 `<release>`。同字节素材可按证据复用，但名称相同或分流比例相同不证明配套。准备器/profile 的冻结输入应按其版本化源码、允许摘要、实际输入与输出清单重新绑定，不把某次历史 hash 当通用批准。

## 二、联网开发环境准备，离线固定构建

1. 在独立分支同步上游已正式合并内容，固定 revision，保留原工作树。审查 manifest、lockfile、`/assets/` 和 `/media/` 路由、WS、昵称/重连、门禁、模拟和 Worker 接点。
2. 从固定源码导出不存在的新目录；逐 blob 校验，拒绝路径穿越、链接、设备和非预期库存。依赖改变按新 lock 准备；复用也核对字节，不用旧整合包覆盖新源码。
3. 保持 `SP_COMBAT=server`、`SP_VERIFY=off` 和必要的本地库/字体适配。宿主调度/守卫程序、systemd、秘密和证据不放进 game app 或公开素材。
4. 集群使用 `tools/cluster-source-export.py`，单独验证 `data/local-assets.json` 与其 atlas/mesh 引用；它是运行资源，不是 Git blob。HTTP200 的空 `groups` 不能算纹理通过。
5. 以已固定 Node 基础镜像离线构建，`--network=none --pull=false`，记录真实 image ID、OCI source/revision 与内容清单；测试使用匹配运行时。简单 `Dockerfile.offline` 与 `cluster/Dockerfile.cluster` 的构建参数不同，不混用。
6. 按改动完成 canonical、真实进程/Worker、隔离 HTTP/WS 和浏览器验收，检查入房、重连、模拟、准备/棋盘/购买部署、Spine、音频与单一 Preact 身份。mock、软件渲染、手机模拟、库存和正文证明各自标明范围；失败/skip 不改称通过。

## 三、公开静态准备与精确映射

公开目录仅为 `releases/<release>/{assets,fonts,vendor}/`。清单和生成配置存运维目录，不放公开资源前缀。每个文件记录相对路径、bytes、SHA-256；归档安全和精确库存校验不能由传输退出码替代。

`tools/prepare-static-release.mjs` 不联网、不改源文件、不激活。`APP_EXPORT` 必须与 game 内容一致；调用方给出的 revision 不是未提交工作树属于该 commit 的证明。`STAGE` 须不存在，仓库内输出只允许 ignored `deploy/stardust/build/`。

```sh
node deploy/stardust/tools/prepare-static-release.mjs \
  --source "$APP_EXPORT" --revision "$SOURCE_REVISION" \
  --release "$STATIC_RELEASE" --out "$STAGE"
node deploy/stardust/tools/prepare-static-release.mjs --verify "$STAGE"
```

工具/模板的 game Origin 和静态坐标是受审查的固定绑定，不提供任意 Origin CLI 开关。上面命令不是其他域名的即装方案；移植需单独审查生成器、模板和门禁。

生成内容包括 `release-manifest.json`、`SHA256SUMS` 及 `nginx/{static-cache,static-files,static-locations,game-static-locations}.conf`。`--verify` 检查额外文件、hash、音频映射、补丁与 includes；纯静态 `game-static-locations.conf` 只是参考，不能覆盖实际多源 Lua/OpenI vhost。

必须保留：

- **fonts.css**：只接受准备器中版本化、已审查的完整模板/摘要；legacy 根路径转相对 URL，精确相对输出幂等。不能因任意 CSS 看似相对就放行。
- **hooks**：普通 immutable vendor 副本的 import 绑定受审查 game origin；root hooks sibling-import adapter 取同候选 game 原件，让 `./preact.module.js` 与主游戏身份一致。上游 import 结构不匹配时停止，不盲目批量替换字符串。
- **音频**：无扩展名 `/media/` URL 最终仍无扩展名，不另跳成 `.mp3`。显式后缀有文件时优先，否则按 `shared/media.js` 的 `AUDIO_EXTS` 顺序选文件；MIME 取实际对象。alias 是精确清单，不是任意路径解析器。
- **公开边界**：仅审核过的 art/fonts/vendor；拒绝未知字体/vendor、业务代码、点路径、软/硬链接及非普通文件。HTML、gate/scene/entry 脚本、业务 JS/CSS、data、API/WS/auth 不进入公开源。PRTS 只公开稳定库/字体。
- **HTTP**：匿名单个 CORS `*`、无 credentials；验收 MIME、HEAD、Range/If-Range/206、ETag/304、OPTIONS、错误 no-store、成功 immutable、目录/隐藏文件/路径穿越拒绝。实际字体/Canvas/Three/Spine/AudioContext 验证不能由库存代替。
- **完整静态配置**：保留模板所需 `map_hash_bucket_size 512`、`map_hash_max_size 8192`；`$asset_cache` 的 `volatile` 保证 Range 后置 416 重新取 no-store，状态 CORS map 避免第二次 filter 追加重复 ACAO。配置测试不能有未处理的 hash 警告。

[OPENI.md](OPENI.md) 与 [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md) 定义镜像、签名和多源合同。保持最多三个明确审核、固定且去重的 OpenI mirrors（旧单／双mirror兼容，第四个拒绝；本次仅已有两目录加固定0.2.3增量目录），ModelScope现有最多八个明确 prefix/pin 及审核过的单资源源站例外；不重传/改名绕过例外或默默忽略全量核验失败。宿主 profile 用固定小 Lua + JSON，消费上限为 100000 aliases；resolver 清单读取有界 64MiB。对完整尺寸数据执行真实 LuaJIT、OpenResty access/header HTTP 和 resolver 盘读检查；`nginx -t` 或 synthetic pin 不能证明实际 provider 绑定。

多源 profile 不是通用 env-switch；实现见 [access.lua](material-lb/access.lua)、[header.lua](material-lb/header.lua)、[prepare-material-lb.py](tools/prepare-material-lb.py) 和 [test-prepare-material-lb.py](tools/test-prepare-material-lb.py)。已知公开 302 缓存不超过 60 秒；OpenI 另受 `Expires-now-30` 限制，只允许固定 `sp_request=cors|display`，去重 Vary Origin/Sec-Fetch-Mode。ModelScope 固定 resolve 入口不套用 OpenI auth_key TTL，也不保证所有下游 CDN 错误自动回退。目标 OpenResty 若在 Lua 后应用 add_header，公开 location 重复必要安全头，但不再次追加 Lua 管理的 Cache-Control/CORS/Vary。

## 四、预置与切换前检查

1. 将新镜像及素材预置到新标签/新目录，保持现用配置。校验归档路径/链接，再逐文件完整 hash；新静态 includes 只在取得对应供给授权、保留旧目录且真实配置测试成功后正常 reload。准备完不代表 game 已切源。
2. 验证实际公开 TLS、正文/alias、缓存/CORS、Range/音频/模型，并检查无业务代码或秘密泄露。完整 LFS SHA/size 库存不等于逐对象重新下载正文，抽样不能写成全量正文。
3. 从实际活动配置确认 simple/core/edge/cluster/Beta 拓扑、组件 revision、secret mount、bind 类型、启动参数、WG/manager 依赖。不要把早期单机三服务视图覆盖集群或独立环境。
4. 私下备份当前 Compose/runtime、精确目标 inspect、image、vhost/includes、policy、secret mount 元数据及配套前缀；比较 CID/PID/StartedAt/restart count，确认预置没有动现有进程。敏感正文不进入输出或公开证据。
5. game/cluster 重建前说明内存房间/对局会终止、客户端需刷新。正常协调玩家和空闲窗口；只有具体用户授权接受立即中断时才例外。回滚不能恢复丢失状态，不设自动切换任务。

## 五、获授权后的协调切换

- 重新读取当前健康、配置和身份，不依赖保存的在线计数。按角色只改本批获授权组件，先证明供给就绪，再协调 game、privatecode、renderer data、resolver manifest、所有活动 pin/alias/profile 和 fallback；不提前让旧对局混用新素材。
- 保持同一 service/project 所有权，不另起隐藏 release project；不动数据库、其他站点、证书、秘密、DNS、Beta 或 WG。未经本批修改的 auth/resolver/代理保持镜像与代次。
- Nginx 先使用**实际启动配置**测试，再正常 reload。目录 bind 可按已核对身份原子 CAS 替换；单文件 bind 要保留 inode、备份和原字节 CAS，不能 rename 后以为容器已读到新文件。不能因默认 PID 路径测试失败而取消只读保护。
- 节点新启动必须用新的 generation。按 [MAIN-THREAD-PRIORITY.md](MAIN-THREAD-PRIORITY.md) 核对完整 revision/image 白名单、真实 Node Main TID、`SCHED_OTHER` + reset-on-fork、Main nice=-20、其余线程0与正确池数；不 nice 整个 Node、不加 CAP_SYS_NICE/CPU/内存 hard cap，保留 PIDs/read-only/cap-drop/no-new-privileges。
- 集群先 CLOSED，再逐目标证明 CID/image/source/runtime/网络/generation/角色健康/priority，最后原子开放精确 WG 租约。漂移失败不自动重新开租约，不全表 flush/restore，不放开 Docker 网段；同伴健康不能替代失败目标。旧 CLOSED guard 迁移须身份/inode/SHA CAS 和新 policy 绑定，不能伪填 hash 或绕过外部审批。
- 保留 [WG-BOOT-RECOVERY.md](WG-BOOT-RECOVERY.md) 的关闭护栏→WG→manager 顺序。显式停/restart 被 `Requires` 依赖的 recovery 会连带停止 manager/game，不能拿它作游戏更新手段。
- 这不是跨主机原子事务或无损迁移。记录每阶段实际结果，失败只回退本次 owned 改动，不重放已消费控制器或重启健康 sibling。

### 独立 auth/PRTS 更新

HTML、资源 map 和 allowlist 在 auth 启动时加载，替换宿主文件不自动生效；必要 auth 替换须单独授权，不能称完全零重启。保持同 project/service，服务专用更新使用 `--no-deps`，不顺带重建 game/ingress/resolver/proxy。昵称策略、公开 PRTS 库和新资源摘要分别核对。

保留 secret mount、UID/权限/字节与旧 session/CSRF 兼容。宿主端口探测发送可信 game Host；容器 loopback probe 才使用 loopback Host，不能为错误探测放宽 Host 门禁。只合并本批精确 CSP 段落、保留 bind inode，并使用实际代理配置测试/reload。只默认跳片头，保留组装/成功/进入动画与 reduced-motion/立即进入兜底，首次/重入都验证身份和 profile。

## 六、验收与私有记录

- 逐组件 schema：simple game/auth 为 HTTP200 且 `ok:true`；resolver 在**容器内部 loopback**检查 HTTP200、合法 JSON 和清单计数，不要求不存在的 `ok`。宿主经端口转发的 resolver probe 可能被拒绝，不能据此降低保护。集群按角色检查，game 认证 status、coordinator 控制健康、ingress 合法 Origin WS，不能统判 all(health.ok)。
- 固定镜像/源码/资源、每角色 generation/lease/priority 与 manifest 精确一致；记录失败服务/字段。新 generation 的 restart0 不擦除先前失败/回滚记录。
- 正常 TLS、登录/CSRF/授权/退出、可信 Host/Origin、匿名/无效凭据私有请求拒绝、内部端点隐藏、安全头和 private/no-store 保持。内存授权 Cookie 检查不冒称真实口令录入，Cookie/秘密不输出落盘。
- 真实浏览器检查同版 Preact/hooks、字体、Spine、模型/音频、邀请/匹配、实际购买部署、Worker/试算与同身份重连；只清理自己的测试房间。未获授权不在运行环境创建玩家/测试对局、生产压测、Inspector、heapdump 或 busy 注入。
- 实际通过、失败、skip、配置备份和阶段回执放 ignored `.claude/releases/` 或仓库外私有归档，遵循 [releases/README.md](releases/README.md)。不在公开文档存管理坐标、日志、用户截图、历史授权或活动计数。

## 七、精确配套回滚与保留

失败先核对当前身份、新对局影响与回滚授权，恢复匹配的**game + privatecode/data + renderer resources + assets/fonts/vendor/media + resolver manifest + 活动 OpenI/ModelScope pin + host Lua/alias/profile**。auth-only 则只撤本批 auth/CSP。只发生同字节源站故障时可按已审查同版本 fallback 合并路由并正常 reload，无须重启 game；不能承诺每种 CDN 错误都自动回退。

先读现用配置，合并必要段落，不整份覆盖陈旧备份。仅撤本次 owned 文件、规则和租约，保留其他环境/共享 WG/其他服务。至少保留当前及上一完整可回退单元和可能被旧页面引用的 immutable 文件；清理须独立授权、检查活动挂载/进程引用与精确库存，不能 global prune。私有发布记录保留原始失败历史，不提交或改写成公开运行快照。证书有效期、续期方式、责任人和监测放私有记录，另行安排，不假定有自动续期。
