# OpenI 素材镜像与签名缓存

## 当前接点：正式 ModelScope60 / OpenI40（2026-10-06）

正式公开 `/assets/`、`/media/` 普通 GET 于 **17:12:58 +08** 切为按请求随机 ModelScope60/OpenI40/宁夏0，**17:19:54 +08** 完成验收。宁夏 HEAD 和原 OpenI 故障回退保留，fonts/vendor/PRTS 仍宁夏；Beta 未接入本次 LB。配套材料仍为 C1 `v013-hangzhou-20261006-1f742992`，不是游戏升级或素材字节更换。

OpenI resolver **仍为 source `063550652867c0c69a193156b77e6f67316f685f` / image `53ac7717`**，没有改镜像或重启。实际只读挂载 `/run/config/openi-assets.json` 的宿主文件是 `/opt/ark-proto/openi-resolver/openi-assets-1f74299291f07e100ca6f522721a29d4c474294c.json`，SHA-256 `b144d019275956c328740dd677a4a328d9b16fa87ebabd710f1cd55e8de07cbc`；无后缀的 `openi-assets.json` 是旧文件，不能用它证明当前清单。当前 24968 个精确请求 alias 与两源材料一致；ModelScope 全量准备及 CORS/浏览器验收见 [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md)。

分流和公开302短缓存由 **宿主 Nginx/Lua** 完成：[access.lua](material-lb/access.lua)、[header.lua](material-lb/header.lua) 及离线 [prepare-material-lb.py](tools/prepare-material-lb.py)/[test-prepare-material-lb.py](tools/test-prepare-material-lb.py)。这些仅锁定当前 C1、镜像 pin 和60:40，不是上传器、自动激活器或通用环境变量切源功能。正式vhost最新SHA为 `cefc036ffbf804c96294b66837a564f5e731172e8e40c897c903a270bbf68e06`；活动记录见 [release JSON](releases/v013-material-lb-20261006-modelscope60-openi40.json)。

以下初次0.1.2库存和单源接入状态是**历史**；签名/路径安全要求仍适用，后续发布不得照旧清单重跑或覆盖当前配置。

## 历史初次分工与发布单元

- 历史初次镜像检查点（不是当前活动声明）：公开数据集：`Stardust_minus/arknight_assets`；生产候选镜像前缀 `releases/v012-openi-20261004/`。
- 此历史镜像对应游戏源码是 `2878299` / 0.1.2，宁夏完整回退资源仍是 `v012-workers-20261004`。这不是一次游戏更新。
- 只镜像 **assets 美术、模型、Spine 和音频**。5515 个独立文件、354380317 字节，对应 9803 个精确请求路径（包括媒体别名）。
- `vendor`、fonts/CSS、PRTS 图形库继续由宁夏发送正文。游戏 HTML/业务 JS/data/WS 和认证维持原路径，不公开新范围。
- 当前简单架构只有 `ark-proto` project 的 `ark-proto-assets` 服务（固定容器同名、回环 3130），与游戏 3120、门禁 3141 共三服务。只取签名并返回小型 302，文件正文由 OBS 直接发送；不再保留蓝绿槽位或多 project 更新。活动清单/镜像以服务器发布记录为准，旧前缀只作 immutable 历史，不覆写/删除。
- 初次记录为游戏6 Worker、maxRooms4096及解析器64 PIDs/只读/安全设置。后来的 D71 已统一零 CPU/内存限制 metadata，当前杭州正式/Beta各12+2；这些历史差异不授权再次 clean 重建。

## 上传与完整性

使用已验证的静态 stage，不能将整个项目、node_modules、凭据目录或临时下载目录交给上传器：

```sh
python3 deploy/stardust/tools/openi-assets.py \
  --stage "$MATCHED_STATIC_STAGE" --prefix releases/NEW_IMMUTABLE_MIRROR \
  --out "$RESOLVER_MANIFEST" --plan-only

python3 deploy/stardust/tools/openi-assets.py \
  --stage "$MATCHED_STATIC_STAGE" --prefix releases/NEW_IMMUTABLE_MIRROR \
  --out "$RESOLVER_MANIFEST" --upload --checkpoint "$UPLOAD_CHECKPOINT"
# 中断后只能在源文件、目标和 checkpoint 匹配时加 --resume。
```

初次上传工具/profile 固定已验证的0.1.2静态 release、源格式和账户；这是历史准备说明，不是当前C1上传许可。未来换版本先审查实际工具的 `RELEASE`/`FALLBACK`、固定profile及格式白名单，再生成新前缀；不得跳过不匹配检查、覆写旧镜像或重跑已完成一次性上传。

工具只在明确 `--upload` 时于本地读取 OpenI 登录文件，不把 Token 写入参数、输出、checkpoint、Git 或部署机。API 使用 Bearer，OBS PUT 使用另一个无账户凭据的 HTTP 客户端。公开下载解析无需 Token，生产解析器没有 Token 配置。

每个源文件验证大小和 SHA-256；PUT 完成检查 MD5 ETag，然后注册，再完整核对远端路径/大小。`upload-ready` 不等于浏览器验收完成，也不声称做过全部远端文件的 SHA-256 重下载。日志/异常只报告安全状态，不记录签名 URL、响应体或凭据。

MP3 远端名映射为 `media/<stem>`，不带扩展名；所有对应的 `/assets/audio/...mp3` 和 `/media/` 别名都指向同一个对象，不复制第二份音频。保留上游避免下载管理器劫持的无扩展名路径。

上传设置 `Cache-Control: public, max-age=31536000, immutable`，已实测可用。不能添加 PUT Content-Type：现有签名会因此被拒绝。OBS 返回 binary MIME，因此 JS 模块不能迁入这个方案；PNG/Canvas、真实 Spine 三件套、音频解码及 Range 已单独测试。

## 签名缓存和回退

- 从公开 API 获取临时链接，按其 `Expires` 缓存；当前实测签名期限约一小时，不把时长写死为签名保证。
- 同一文件/音频别名共用签名缓存，冷请求合并，近过期时后台刷新；提前 30 秒停止使用旧签名，失败时绝不返回过期链接。
- OBS 未带 Origin 的响应没有 CORS 头且未设置 Vary。为兼容现有页面的普通图片、预加载、CSS 背景和 Canvas 混合用法，HTTP 跳转在不修改签名字段/对象路径/期限的基础上添加固定 `sp_request=display/cors` 缓存区分参数，并设置 `Vary: Origin, Sec-Fetch-Mode`。当前 Signature V2 链路已通过真实 GET、哈希和浏览器缓存验证；两种正常图片请求都走 OpenI，不按图片类型留在宁夏，也不需要修改/重启游戏。
- 缓存隔离可能使同图保存两份浏览器缓存；它依赖平台继续接受该固定非签名参数，平台接口变化时必须重新验证。纯 302 服务看不到浏览器跟随后的所有 OSS 错误，不能宣称任意下游错误都会自动回退。
- `PREWARM=1` 开启内置后台预热：启动后逐个预热所有独立文件，闲置文件也在刷新期限到来前续签；只获取签名，不下载素材正文。索引堆为每个文件保留一个期限，后台最多两个任务，前台队列优先，至少保留两个前台名额；所有路径/别名共用 singleflight。不会每隔一分钟无条件重签全部文件。
- API 并发、排队、超时、重试及 429 退避有界；未知路径不请求平台。签名必须是指定 OBS 主机、指定对象路径和允许的查询字段。
- 解析失败/队列满时，由解析器 302 到同版本宁夏。解析器宕机、连接/响应超时或 5xx 时，由 Nginx named location 做同样回退。
- HEAD 使用宁夏回退，因为 OpenI 的 GET 签名不允许 HEAD；不要把一次 HEAD 403 当作 OBS GET 文件损坏。
- **历史单源策略**是302始终 no-store；当前仅正式已知公开素材302由Lua收窄为短缓存：稳定 pinned ModelScope/宁夏跳转 `public, max-age=60`，OpenI签名跳转 `max-age <= min(60, Expires-now-30)`；剩余期限不足、未知/重复查询字段或不匹配目标均 no-store。仅额外接受固定 `sp_request=cors|display`，不能放宽任意查询。OPTIONS/公开错误保持 no-store，named故障回退保留保守 private,no-store，认证/业务未变。OBS正文长期缓存与跨签名永久复用仍是两回事。
- 健康计数包括命中、冷请求、实际 `apiRequests`、刷新、失败、回退、排队和缓存项；没有 URL 或凭据。Docker bridge 请求 `/healthz` 返回 404，使用容器内部回环检查。

## 部署和验收

1. 完成上传器远端库存核对和独立浏览器渲染验收，保存 generated manifest/checkpoint 在 Git 外。生成文件默认0600；安装到新 revision-suffixed 宿主清单，权限0644供容器UID1000只读挂载，并从实际 Docker mount 核对路径/摘要。当前C1使用上方 `openi-assets-1f742992…json`，不是历史无后缀文件；不能仅凭命名猜测现用清单。
2. 从固定 commit 离线构建 `openi-resolver/Dockerfile`，传入 `SOURCE_REVISION` 并记录镜像 ID；无需 npm、SDK、账户 Token 或美术文件进入镜像。
3. 使用完整 `compose.yaml` 或同 project 的 `compose.assets.yaml` 专用视图和同一 `runtime.env`，只更新固定 `ark-proto-assets` 服务，不另起备用容器。更新前确认宁夏同版本 fallback 可用；解析器重启后缓存冷启动，`PREWARM=1` 会重新预热。在授权窗口内接受短暂 fallback，并检查容器内 `/healthz` 的 `warmComplete=true`、`prewarmRemaining=0`；Docker healthy 不代替缓存就绪证明。只更新素材供应源不得顺带重建游戏/auth。
4. 备份实际vhost/正常snippets；`ark_proto_assets_backend`仍只指3130。历史单源接入令 `/assets/`、`/media/` 全到OpenI；当前已知公开GET先经宿主Lua60:40选择，OpenI分支继续原resolver及fallback。root hooks直接游戏，fonts/vendor/PRTS仍宁夏，业务/认证/WS门禁与严格Origin不变。不要恢复旧端口、generic release routing或网关预算。目标OpenResty的add_header在Lua之后执行；公开location须重复现有HSTS/nosniff/frame/referrer/CSP，省略Lua管理的CC/CORS/Vary，不能造成重复头或丢失安全头。
5. `nginx -t` 后平滑 reload，不重启游戏或认证。Nginx 不记录 Location、不跟随 OSS 302，Cookie/Authorization 等不进入解析器；只给浏览器返回签名能力。
6. 正式浏览器复查完整贴图/Spine/音频、PRTS/昵称/热缓存，比较游戏/认证容器 ID、StartedAt、restart count，确保全部未变。
7. 新版游戏发布必须同步准备宁夏回退目录、OpenI 新镜像和解析清单。不要直接使用旧 `game-static-locations.conf` 覆盖掉解析路由；检查 fallback release 和清单 release 配套。

回退本功能只需按现用 vhost 合并恢复同版本的 `/assets/`、`/media/` 宁夏重定向并平滑 reload。保留完整宁夏目录；不删除已发布 OpenI 前缀，不重启游戏，不修改任何凭据或数据集可见性。

**历史小样本结论已被2026-10-06全量准备及17:19正式验收取代**：ModelScope已参与正式60:40分流。仍不能把CDN `auth_key` 的签发时间当OpenI `Expires`，或套用一小时TTL。本站只302到稳定、40hex revision-pinned的ModelScope resolve入口，后续provider302/CDN由浏览器跟随；不保存或自行解释临时CDN链接，正文不经嘉兴。全量7200对象的远端LFS SHA/size库存已验证，未全部重下载正文。实际匿名Chrome重定向、body hash、AudioContext及Spine渲染通过；这些不构成本批密码输入或玩法验收，也不能保证所有下游CDN错误自动回退。
