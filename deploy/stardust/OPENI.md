# OpenI 素材镜像与签名缓存

## 分工与发布单元

- 公开数据集：`Stardust_minus/arknight_assets`；生产候选镜像前缀 `releases/v012-openi-20261004/`。
- 对应游戏源码仍是 `2878299` / 0.1.2，宁夏完整回退资源仍是 `v012-workers-20261004`。这不是一次游戏更新。
- 只镜像 **assets 美术、模型、Spine 和音频**。5515 个独立文件、354380317 字节，对应 9803 个精确请求路径（包括媒体别名）。
- `vendor`、fonts/CSS、PRTS 图形库继续由宁夏发送正文。游戏 HTML/业务 JS/data/WS 和认证维持原路径，不公开新范围。
- 嘉兴新增 `ark-proto-assets`，回环 `127.0.0.1:3110`；它只取签名并返回小型 302，文件正文由 OBS 直接发送。
- 新解析器单独限制 0.5 CPU / 192 MiB / 64 PIDs；这些不是游戏限额。游戏的 6 Worker、maxRooms 4096 和无限额配置不变。

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

当前上传器刻意固定已验证的 0.1.2 静态 release、源格式和账户。未来换版本时先审查 `RELEASE`/`FALLBACK` 及格式白名单，再生成新前缀；不得跳过不匹配检查或覆盖旧镜像。

工具只在明确 `--upload` 时于本地读取 OpenI 登录文件，不把 Token 写入参数、输出、checkpoint、Git 或部署机。API 使用 Bearer，OBS PUT 使用另一个无账户凭据的 HTTP 客户端。公开下载解析无需 Token，生产解析器没有 Token 配置。

每个源文件验证大小和 SHA-256；PUT 完成检查 MD5 ETag，然后注册，再完整核对远端路径/大小。`upload-ready` 不等于浏览器验收完成，也不声称做过全部远端文件的 SHA-256 重下载。日志/异常只报告安全状态，不记录签名 URL、响应体或凭据。

MP3 远端名映射为 `media/<stem>`，不带扩展名；所有对应的 `/assets/audio/...mp3` 和 `/media/` 别名都指向同一个对象，不复制第二份音频。保留上游避免下载管理器劫持的无扩展名路径。

上传设置 `Cache-Control: public, max-age=31536000, immutable`，已实测可用。不能添加 PUT Content-Type：现有签名会因此被拒绝。OBS 返回 binary MIME，因此 JS 模块不能迁入这个方案；PNG/Canvas、真实 Spine 三件套、音频解码及 Range 已单独测试。

## 签名缓存和回退

- 从公开 API 获取临时链接，按其 `Expires` 缓存；当前实测签名期限约一小时，不把时长写死为签名保证。
- 同一文件/音频别名共用签名缓存，冷请求合并，近过期时后台刷新；提前 30 秒停止使用旧签名，失败时绝不返回过期链接。
- OBS 未带 Origin 的响应没有 CORS 头且未设置 Vary。为兼容现有页面的普通图片、预加载、CSS 背景和 Canvas 混合用法，HTTP 跳转在不修改签名字段/对象路径/期限的基础上添加固定 `sp_request=display/cors` 缓存区分参数，并设置 `Vary: Origin, Sec-Fetch-Mode`。当前 Signature V2 链路已通过真实 GET、哈希和浏览器缓存验证；两种正常图片请求都走 OpenI，不按图片类型留在宁夏，也不需要修改/重启游戏。
- 缓存隔离可能使同图保存两份浏览器缓存；它依赖平台继续接受该固定非签名参数，平台接口变化时必须重新验证。纯 302 服务看不到浏览器跟随后的所有 OSS 错误，不能宣称任意下游错误都会自动回退。
- API 并发、排队、超时、重试及 429 退避有界；未知路径不请求平台。签名必须是指定 OBS 主机、指定对象路径和允许的查询字段。
- 解析失败/队列满时，由解析器 302 到同版本宁夏。解析器宕机、连接/响应超时或 5xx 时，由 Nginx named location 做同样回退。
- HEAD 使用宁夏回退，因为 OpenI 的 GET 签名不允许 HEAD；不要把一次 HEAD 403 当作 OBS GET 文件损坏。
- 302 始终 no-store，避免浏览器长期保存已失效跳转。OBS 文件正文可长期缓存，但签名更新改变完整 URL 后，浏览器可能重新下载；不能把“同一签名 URL 缓存一年”等同于“跨签名永久复用”。
- 健康计数包括命中、冷请求、实际 `apiRequests`、刷新、失败、回退、排队和缓存项；没有 URL 或凭据。Docker bridge 请求 `/healthz` 返回 404，使用容器内部回环检查。

## 部署和验收

1. 完成上传器的远端库存核对和独立浏览器渲染验收，保存 generated manifest/checkpoint 在 Git 外。生成文件默认 0600；安装一份公开清单到 `/opt/ark-proto/openi-resolver/openi-assets.json`，权限 0644，供容器 UID 1000 只读挂载。
2. 从固定 commit 离线构建 `openi-resolver/Dockerfile`，传入 `SOURCE_REVISION` 并记录镜像 ID；无需 npm、SDK、账户 Token 或美术文件进入镜像。
3. 只启动 `compose.assets.yaml`，绝不对游戏 Compose 执行重建。先验证冷解析、同 URL 缓存复用、无扩展名音频、真实大小/哈希、CORS/Range、未知路径和健康隐私。
4. 备份实际 vhost 与新 snippet；新增 `ark_proto_assets_backend`，只把 `/assets/`、`/media/` 接到 `asset-resolver-location.conf`。不改变 fonts/vendor/PRTS/业务/认证/WS 路由。
5. `nginx -t` 后平滑 reload，不重启游戏或认证。Nginx 不记录 Location、不跟随 OSS 302，Cookie/Authorization 等不进入解析器；只给浏览器返回签名能力。
6. 正式浏览器复查完整贴图/Spine/音频、PRTS/昵称/热缓存，比较游戏/认证容器 ID、StartedAt、restart count，确保全部未变。
7. 新版游戏发布必须同步准备宁夏回退目录、OpenI 新镜像和解析清单。不要直接使用旧 `game-static-locations.conf` 覆盖掉解析路由；检查 fallback release 和清单 release 配套。

回退本功能只需恢复备份的 `/assets/`、`/media/` 宁夏重定向并平滑 reload。保留完整宁夏目录；不删除已发布 OpenI 前缀，不重启游戏，不修改任何凭据或数据集可见性。

ModelScope `Stardust/arknight-assets` 已做单独小样本试验，但不属于本次主源。不能未经验证就把 CDN `auth_key` 当作 OpenI `Expires` 套用，也不能把探测文件当作全量已镜像。
