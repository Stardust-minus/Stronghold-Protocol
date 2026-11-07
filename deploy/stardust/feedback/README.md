# 玩家反馈板（/feedback）

玩家提交 Bug 反馈和建议的公开留言板：登录口令门后的所有玩家都能看到全部条目，服主可以回复、设置状态、隐藏或删除。
独立的小服务（Node 24 ESM、原生 `node:http`、无框架、无 npm 依赖），数据存在一个 SQLite 文件里（Node 内置
`node:sqlite`，服主批准的「不引入数据库」规则例外）。只跑在边缘机 OpenResty 后面。

| 文件 | 内容 |
| --- | --- |
| `server.mjs` | HTTP 路由、Origin/会话/服主检查、页面和静态文件；`createFeedbackServer(options)` 工厂，直接执行时启动服务 |
| `store.mjs` | SQLite：表结构与迁移、列表/搜索/计数、每日备份 |
| `policy.mjs` | 文本清洗与长度、内存限流、服主密钥文件 |
| `public/` | 前端页面（`index.html` 和平铺的静态文件，由主助手维护） |
| `test/feedback.test.mjs` | `node --test` 用例（进程内真实 HTTP、临时库、注入时钟） |

## 数据

- 分类（固定）：`bug` Bug 反馈、`gameplay` 玩法建议、`ui` 界面与体验、`other` 其他。
- 状态（固定）：`unassigned` 未分配（默认）、`unplanned` 无计划、`planned` 已计划、`updated` 已更新。
- 条目 JSON：`{ id, category, title, body, author, client, status, reply, replyAt, createdAt, updatedAt }`，时间为毫秒；
  `author` / `reply` 为 `''` 表示匿名 / 未回复，`replyAt` 无回复时为 `null`。服主视图多一个 `hidden`。
- 不保存 IP、会话签名或它们的任何哈希；限流状态只在内存里，重启即清空。日志只有启动、数量和内部错误，不记录 IP、密钥、会话或正文。
- 数据库：`FEEDBACK_DB`（默认 `/data/feedback.sqlite`），WAL + `synchronous=FULL`，`schema_version` 表记录迁移。id 用
  AUTOINCREMENT，删除的 id 不会再分配。
- 备份：设置 `FEEDBACK_BACKUP_DIR` 后，启动时若当天（UTC）备份不存在就 `VACUUM INTO` 生成
  `feedback-YYYY-MM-DD.sqlite`，之后每小时检查一次（即每天一份），只保留最新 14 份；目录里的其他文件不动。
  恢复：停服务，把某份备份复制为 `FEEDBACK_DB`（同时删掉旧的 `-wal` / `-shm`），再启动。

## 文本规则

码点数在清洗和 NFC 之后计算。标题 / 署名 / 客户端信息：所有空白变成一个空格、去掉控制字符、首尾去空白；正文 / 回复：
CRLF 和单独的 CR 变 LF，去掉 C0/C1 控制字符（保留 LF 和 TAB），首尾去空白。

| 字段 | 码点 |
| --- | --- |
| `title` | 2–80 |
| `body` | 5–4000 |
| `author` | 0–24（可省略） |
| `client` | 0–160（可省略；页面自动填浏览器/系统/版本摘要） |
| `reply` | 0–2000（`''` 清除回复） |

## 接口（都在 `/feedback` 下）

| 方法 路径 | 说明 |
| --- | --- |
| `GET /feedback` | 301 到 `/feedback/`（保留查询串） |
| `GET /feedback/` | `public/index.html`，其中 `__ASSET_VERSION__` 替换为 `public/` 全部顶层文件的内容哈希（12 位十六进制，启动时计算） |
| `GET /feedback/assets/<名>` | `public/` 里的平铺文件（不含子目录、点文件和 index.html；只认 .js .css .svg .png .webp .woff2 .ico）；带 `?v=<当前哈希>` 时 `immutable`，否则 `private, no-cache`；有 ETag |
| `GET /feedback/api/items?status=&category=&q=&before=&limit=` | `{ items, next, counts }`，新的在前，`before=<id>` 翻页，`limit` 默认 20、超过 50 按 50；`counts` 只受分类和搜索影响，不受状态影响；`status` / `category` 为空或 `all` 表示不过滤 |
| `GET /feedback/api/items/:id` | `{ item }`；隐藏的条目对玩家是 404 |
| `POST /feedback/api/items` | JSON `{ category, title, body, author?, client? }` → 201 `{ item }` |
| `GET /feedback/api/admin` | 服主密钥有效 204，否则 403 `OWNER`；没有有效服主文件 503 `OWNER_DISABLED` |
| `POST /feedback/api/items/:id/admin` | 服主：JSON `{ status?, reply?, hidden? }` → 200 `{ item }`（服主视图） |
| `DELETE /feedback/api/items/:id` | 服主：204 |
| `GET /feedback/api/health` | `{ ok: true, items: <可见条目数> }` |

搜索 `q`：清洗后最多 64 个码点（超过 400），按空白拆分，取前 5 个词，全部命中才算（AND）；每个词在标题、正文、回复、
署名里做子串匹配（`LIKE … ESCAPE '\'`，`%` `_` `\` 按字面），ASCII 不区分大小写；一两个汉字也能搜（所以不用 FTS）。

错误都是 JSON `{ error }`，不回显输入：

| 状态 | `error` |
| --- | --- |
| 400 | `INVALID`（带 `field`：字段名，或查询参数 `status` `category` `q` `before` `limit`）、`BAD_JSON`、`BAD_REQUEST` |
| 403 | `ORIGIN`（POST/DELETE 的 `Origin` 不等于 `FEEDBACK_ORIGIN`，或 `Sec-Fetch-Site` 存在且不是 `same-origin`）、`NO_SESSION`（缺 `X-Ark-Session`）、`OWNER` |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED`（带 `Allow`） |
| 409 | `DUPLICATE`（带 `id`：24 小时内已有同样标题+正文的条目，含隐藏条目；不消耗限额） |
| 413 / 415 | `TOO_LARGE`（请求体超过 16 KiB）/ `UNSUPPORTED_MEDIA_TYPE`（不是 `application/json`） |
| 429 | `RATE_LIMITED`（带 `retryAfter` 秒和 `Retry-After` 头） |
| 503 | `OWNER_DISABLED` |

API 响应 `Cache-Control: no-store`；页面带 `Content-Security-Policy`（`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`），所有响应带
`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`。

## 限额（内存滑动窗口，只统计成功发出的条目）

- 每个门禁会话（`X-Ark-Session`）：10 分钟 3 条，24 小时 15 条；
- 每个客户端地址（IPv4 按单个地址，IPv6 按 /64）：24 小时 30 条；
- 全站：1 小时 120 条；
- 服主密钥输错：每个地址 10 分钟 10 次，超过后 `/api/admin` 和服主写操作返回 429，GET 列表/详情按普通玩家处理。

## 服主

请求头 `X-Owner-Key: <服主密钥>`。密钥文件与游戏的 `SP_OWNER_FILE` 同格式、同校验（`server/ownerFile.js`）：
`{ "names": [...], "keySha256": "<64 位十六进制>" }`，不允许其他键；这里只用 `keySha256`（SHA-256 后
`timingSafeEqual` 比较）。由 `FEEDBACK_OWNER_FILE` 指定，每 5 秒在请求之外检查一次 mtime/大小/inode，变了就重读；
未设置、文件不存在或格式不对时服主功能关闭。挂载**目录**而不是文件（编辑器保存会换 inode）。文件和密钥不会写进日志。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FEEDBACK_ORIGIN` | 必填 | 站点 origin，例如 `https://ark-proto.stardust.matce.cn`；POST/DELETE 的 `Origin` 必须完全相同 |
| `FEEDBACK_HOST` | `127.0.0.1` | 监听地址（镜像里设为 `0.0.0.0`，靠端口只发布到宿主机回环） |
| `FEEDBACK_PORT` | `3150` | 端口 |
| `FEEDBACK_DB` | `/data/feedback.sqlite` | 数据库文件（目录自动创建） |
| `FEEDBACK_OWNER_FILE` | 空 | 服主文件 |
| `FEEDBACK_BACKUP_DIR` | 空 | 备份目录；空则不备份 |

## nginx

口令门（`auth_request`）照常作用于 `/feedback/`；路径原样转发；**`X-Real-IP` 和 `X-Ark-Session` 必须由 nginx 用
`proxy_set_header` 设置**（这样客户端自带的同名头不会透传；变量为空时 nginx 不发这个头，服务返回 `NO_SESSION`）。
location 里只要写了任何 `proxy_set_header`，server 级的就不再继承，需要的头都要在这里写全。

站点模板 `deploy/stardust/nginx/ark-proto.conf` 已带好这两个 location（`/feedback` 301 到 `/feedback/`；
`client_max_body_size 32k`；每 IP 10 r/s；`X-Real-IP`、`X-Ark-Session` 由 nginx 设置；不转发 Cookie）。服务自己的
`Cache-Control` 被 server 级 `proxy_hide_header` 去掉，改用缓存 map：`/feedback/assets/` 为 `private, max-age=86400`
（页面以 `?v=` 内容哈希引用这些文件），页面和 API 是 `private, no-store`；CSP 用服务自己下发的。
未登录时打开 `/feedback/` 会跳到登录页（`$ark_proto_html` 里有 `/feedback/`）；门禁登录后回到 `/feedback/`（auth 的
`safeNext` 只额外认可 `/feedback/`、`/monitor/` 和公开仪表盘这几个边缘页面，其他目标仍回游戏首页）。

## 运行

`compose.feedback.yaml`（`feedback.env.example` 复制成 `feedback.env` 填好；`feedback.env` 不入库）：host 网络、只监听
127.0.0.1:3150、只读根文件系统、uid 1000。

```bash
docker build -t ark-feedback:<tag> deploy/stardust/feedback
install -d -o 1000 -g 1000 -m 700 <数据目录>                 # SQLite 与每日备份
install -d -o 1000 -g 1000 -m 700 <服主文件目录>             # 放 owner.json（与游戏 SP_OWNER_FILE 同一份），uid 1000 可读
docker compose --env-file feedback.env -f compose.feedback.yaml up -d
```

`SIGTERM` / `SIGINT`：停止接收新连接，等进行中的请求结束后关库退出（最多 5 秒）。
本地直接运行：`FEEDBACK_ORIGIN=http://127.0.0.1:3150 FEEDBACK_DB=/tmp/feedback.sqlite node deploy/stardust/feedback/server.mjs`。

## 测试

```bash
node --test deploy/stardust/feedback/test/*.test.mjs
```

覆盖创建与校验、会话/Origin/媒体类型/大小/方法、各项限额、重复、列表分页筛选计数、搜索、隐藏与服主操作、服主文件变化、
密钥错误限流、重启持久化、备份轮换、静态文件白名单/版本哈希/CSP 与路径穿越。
