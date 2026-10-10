# OpenI 素材镜像与签名缓存

## 分工与发布单元

只镜像公开 **assets美术、模型、Spine和音频**。vendor、fonts/CSS、PRTS库继续使用同版本静态回退源；HTML、业务JS/data、WS和认证不因此公开。解析器只取签名并返回小型302，正文由provider直接发送。

公开GET的选择与短缓存由宿主Nginx/Lua完成：[access.lua](material-lb/access.lua)、[header.lua](material-lb/header.lua)及离线[prepare-material-lb.py](tools/prepare-material-lb.py)/[test-prepare-material-lb.py](tools/test-prepare-material-lb.py)。它们不是上传器、自动激活器或通用环境变量切源功能。分流合同见[MATERIAL-SOURCES.md](MATERIAL-SOURCES.md)。

清单、镜像及fallback必须绑定同一批准release；实际数据集、mirror prefix、revision、宿主清单挂载及验收结果保存在Git外的私有记录，见[记录边界](releases/README.md)。本页不声明某环境已经安装或验收。

## 上传与完整性

以下是准备命令示例。使用已验证的静态 stage，不能将整个项目、node_modules、凭据目录或临时下载目录交给上传器：

```sh
python3 -I deploy/stardust/tools/openi-assets.py \
  --stage "$MATCHED_STATIC_STAGE" --prefix releases/NEW_IMMUTABLE_MIRROR \
  --out "$RESOLVER_MANIFEST" --plan-only

python3 -I deploy/stardust/tools/openi-assets.py \
  --stage "$MATCHED_STATIC_STAGE" --prefix releases/NEW_IMMUTABLE_MIRROR \
  --out "$RESOLVER_MANIFEST" --upload --checkpoint "$UPLOAD_CHECKPOINT"
# 中断后只能在源文件、目标和 checkpoint 匹配时加 --resume。
```

工具可能固定release、fallback、源格式和公开dataset/profile；使用前审查实际工具的 `RELEASE`/`FALLBACK`及格式白名单。示例前缀不是有效上线配置，不能跳过不匹配检查、覆写旧镜像或重跑已完成一次性上传。

工具只在明确 `--upload` 时于本地读取 OpenI 登录文件，不把 Token 写入参数、输出、checkpoint、Git 或部署机。API 使用 Bearer，OBS PUT 使用另一个无账户凭据的 HTTP 客户端。公开下载解析无需 Token，生产解析器没有 Token 配置。

每个源文件验证大小和 SHA-256；PUT 完成检查 MD5 ETag，然后注册，再完整核对远端路径/大小。`upload-ready` 不等于浏览器验收完成，也不声称做过全部远端文件的 SHA-256 重下载。日志/异常只报告安全状态，不记录签名 URL、响应体或凭据。

MP3 远端名映射为 `media/<stem>`，不带扩展名；所有对应的 `/assets/audio/...mp3` 和 `/media/` 别名都指向同一个对象，不复制第二份音频。保留上游避免下载管理器劫持的无扩展名路径。

上传使用 `Cache-Control: public, max-age=31536000, immutable`，provider行为须独立核验。不能添加 PUT Content-Type：现有签名会因此被拒绝。OBS 返回 binary MIME，因此 JS 模块不能迁入这个方案；PNG/Canvas、完整Spine三件套、音频解码及Range须单独测试。

## 签名缓存和回退

- 从公开 API 获取临时链接，按其 `Expires` 缓存；不能把样本时长写死为签名保证。
- 同一文件/音频别名共用签名缓存，冷请求合并，近过期时后台刷新；提前 30 秒停止使用旧签名，失败时绝不返回过期链接。
- OBS 未带 Origin 的响应没有 CORS 头且未设置 Vary。为兼容现有页面的普通图片、预加载、CSS 背景和 Canvas 混合用法，HTTP 跳转在不修改签名字段/对象路径/期限的基础上添加固定 `sp_request=display/cors` 缓存区分参数，并设置 `Vary: Origin, Sec-Fetch-Mode`。Signature V2链路须通过真实GET、哈希及浏览器缓存检查；两种正常图片请求都走 OpenI，不按图片类型留在同版本静态回退源，也不需要修改/重启游戏。
- 缓存隔离可能使同图保存两份浏览器缓存；它依赖平台继续接受该固定非签名参数，平台接口变化时必须重新验证。纯 302 服务看不到浏览器跟随后的所有 OSS 错误，不能宣称任意下游错误都会自动回退。
- `PREWARM=1` 开启内置后台预热：启动后逐个预热所有独立文件，闲置文件也在刷新期限到来前续签；只获取签名，不下载素材正文。索引堆为每个文件保留一个期限，后台最多两个任务，前台队列优先，至少保留两个前台名额；所有路径/别名共用 singleflight。不会每隔一分钟无条件重签全部文件。
- API 并发、排队、超时、重试及 429 退避有界；未知路径不请求平台。签名必须是指定 OBS 主机、指定对象路径和允许的查询字段。
- 解析失败/队列满时，由解析器 302 到同版本同版本静态回退源。解析器宕机、连接/响应超时或 5xx 时，由 Nginx named location 做同样回退。
- HEAD 使用同版本静态回退源回退，因为 OpenI 的 GET 签名不允许 HEAD；不要把一次 HEAD 403 当作 OBS GET 文件损坏。
- 解析器原生302始终no-store；只有已知公开素材可由配套Lua收窄为短缓存：稳定 pinned ModelScope/同版本静态回退源跳转 `public, max-age=60`，OpenI签名跳转 `max-age <= min(60, Expires-now-30)`；剩余期限不足、未知/重复查询字段或不匹配目标均 no-store。仅额外接受固定 `sp_request=cors|display`，不能放宽任意查询。OPTIONS/公开错误保持 no-store，named故障回退保留保守 private,no-store，认证/业务未变。OBS正文长期缓存与跨签名永久复用仍是两回事。
- 健康计数包括命中、冷请求、实际 `apiRequests`、刷新、失败、回退、排队和缓存项；没有 URL 或凭据。Docker bridge 请求 `/healthz` 返回 404，使用容器内部回环检查。

## 部署和验收

1. 完成上传器远端库存核对和独立浏览器渲染验收，保存 generated manifest/checkpoint 在 Git 外。生成文件默认0600；安装到新 revision-suffixed 宿主清单，权限0644供容器UID1000只读挂载，并从实际 Docker mount 核对路径/摘要。宿主文件名示例为 `openi-assets-<SOURCE_REVISION>.json`；不能仅凭命名猜测现用清单。
2. 从固定 commit 离线构建 `openi-resolver/Dockerfile`，传入 `SOURCE_REVISION` 并记录镜像 ID；无需 npm、SDK、账户 Token 或美术文件进入镜像。
3. 使用完整 `compose.yaml` 或同 project 的 `compose.assets.yaml` 专用视图和同一 `runtime.env`，只更新固定 `ark-proto-assets` 服务，不另起备用容器。更新前确认同版本静态回退源同版本 fallback 可用；解析器重启后缓存冷启动，`PREWARM=1` 会重新预热。在授权窗口内接受短暂 fallback，并检查容器内 `/healthz` 的 `warmComplete=true`、`prewarmRemaining=0`；Docker healthy 不代替缓存就绪证明。只更新素材供应源不得顺带重建游戏/auth。
4. 备份实际vhost/正常snippets；`ark_proto_assets_backend`只指向所选profile的固定解析器监听。单源接入与宿主Lua多源选择应分别审查；OpenI分支继续解析器及同版fallback。root hooks仍直接游戏，fonts/vendor/PRTS仍同版本静态回退源，业务/认证/WS门禁与严格Origin不变。不要恢复旧端口、generic release routing或网关预算。须核验目标OpenResty的header filter顺序；若add_header在Lua之后执行，公开location须重复现有HSTS/nosniff/frame/referrer/CSP，省略Lua管理的CC/CORS/Vary，不能造成重复头或丢失安全头。
5. `nginx -t` 后平滑 reload，不重启游戏或认证。Nginx 不记录 Location、不跟随 OSS 302，Cookie/Authorization 等不进入解析器；只给浏览器返回签名能力。
6. 使用真实浏览器复查完整贴图/Spine/音频、PRTS/昵称/热缓存，比较游戏/认证容器 ID、StartedAt、restart count，确保全部未变。
7. 新版游戏发布必须同步准备同版本静态回退源回退目录、OpenI 新镜像和解析清单。不要直接使用旧 `game-static-locations.conf` 覆盖掉解析路由；检查 fallback release 和清单 release 配套。

回退本功能只需按现用 vhost 合并恢复同版本的 `/assets/`、`/media/` 同版本静态回退源重定向并平滑 reload。保留完整同版本静态回退源目录；不删除已发布 OpenI 前缀，不重启游戏，不修改任何凭据或数据集可见性。

## 多源与验证边界

公开材料消费者限额为100000 aliases／64MiB输入，OpenI最多三个明确审核、固定且去重的mirror目录（保持旧单／双mirror兼容，拒绝第四个）；本次新增供给仅为已有两目录之外的固定0.2.3增量目录，不授权自动发现或扩容。ModelScope现有上限仍为八个明确批准的prefix。唯一批准的素材例外为 `/assets/skins/char_340_shwaz_snow_1/illustration.png` 的OpenI-only供给；不通过改名重传或旧pin绕过provider限制，也不泛化其他例外。

不能把ModelScope CDN `auth_key` 的签发时间当OpenI `Expires`，或套用固定TTL。本站只302到稳定、40hex revision-pinned的ModelScope resolve入口，不保存或自行解释临时CDN链接。metadata库存核验、远端正文抽样、完整正文重下载和浏览器验收须分别记录；这些不自动构成密码输入、玩法或容量验收，也不能保证任意下游CDN错误自动回退。
