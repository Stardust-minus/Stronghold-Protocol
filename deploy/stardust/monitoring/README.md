# 卫戍协议 · 公开服务器状态监控（Prometheus + Grafana）

给玩家看的服务器状态页：在线玩家、对局、游戏服务健康度和济南入口机器的带宽/负载。整套服务跑在公网入口机（济南，
Ubuntu + Docker，OpenResty 以 host 网络运行）上，只通过 Grafana 的「公开仪表盘」对外展示；管理界面只走 SSH 隧道。

本目录改编自 xinhai-ai/Stronghold-Protocol 的 `deploy/monitoring`（GPL-3.0-or-later），保留了它的安全做法：
固定采集目标、不接受 `?target=`（不会变成 SSRF 代理）、超时、2 MiB 上限、不跟随重定向、采集不重叠、标签取值有限、
Prometheus 与 collector 不对外。不同之处：本服务器没有 `/metrics`，数据来源是集群协调器（coordinator）的
`/healthz?traffic=1` JSON。

## 1. 组件与端口

全部容器 `network_mode: host`，只监听 127.0.0.1，不发布任何端口：

| 服务 | 镜像（固定版本） | 监听 | 作用 |
|---|---|---|---|
| collector | 本目录 `collector/` 构建，`node:24.22.0-alpine3.24` | 127.0.0.1:9108 | 每 10 秒（超时 5 秒）拉取 `MONITOR_HEALTHZ_URL`，转成 `sp_*` 指标 |
| node-exporter | `prom/node-exporter:v1.12.1` | 127.0.0.1:9100 | 入口机 CPU / 内存 / 负载 / 网卡（除 lo 和 Docker 的虚拟网卡外都采，公网网卡不论叫什么名字）/ TCP 发送与重传段数、重传超时 / 文件系统 |
| prometheus | `prom/prometheus:v3.15.0` | 127.0.0.1:9090 | 采集 15 秒（collector 10 秒），保留 **30 天 / 5 GB**，预计算面板用的 recording rules |
| grafana | `grafana/grafana:13.2.4` | 127.0.0.1:3160（子路径 `/monitor/`） | 中文深色仪表盘「卫戍协议 · 服务器状态」（uid `sp-status`） |
| （外部）OpenResty 指标 | — | 127.0.0.1:9145 | `ark_edge_*`，由站点 Nginx 配置提供（`deploy/stardust/nginx/edge-metrics-*.conf`） |

镜像摘要（2026-10-16 在开发机拉取核对）：

```
node@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f              (24.22.0-alpine3.24)
prom/node-exporter@sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0 (v1.12.1)
prom/prometheus@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e    (v3.15.0)
grafana/grafana@sha256:dbbc38ea21103cefb50396340cd88afec779c7e070b0a7bf5a75b4ce46651d3f    (13.2.4)
```

资源：每个容器 `restart: unless-stopped`、`read_only`、`cap_drop: [ALL]`、`no-new-privileges`、`cpu_shares: 128`
（低于默认 1024，不和 OpenResty 抢 CPU）、日志 10 MB × 3；内存上限 collector 96 MB、node-exporter 64 MB、
Prometheus 512 MB、Grafana 1.5 GB（`GOMEMLIMIT=1GiB`，只加载 Prometheus 数据源插件；768 MB 时 80 个页面同时打开
会被 OOM，所以 Nginx 另外把查询 API 的总并发限制在 48）。

## 2. 安全边界

- 对外只有 Grafana 的公开仪表盘：Nginx 在 `/monitor/` 下只放行
  `/monitor/public-dashboards/`、`/monitor/api/public/`、`/monitor/public/`（静态文件），其余 `/monitor/...` 一律 404。
  登录、管理 API、数据源代理、`/monitor/apis/...` 都到不了 Grafana。公开页本身会请求一次
  `/monitor/apis/dashboard.grafana.app/`，被 404 后页面照常显示（已用无头浏览器验证）。
- Grafana：匿名访问关闭、禁止注册、管理员密码只从文件读取（`GF_SECURITY_ADMIN_PASSWORD__FILE`）、`cookie_secure`、
  Grafana Live 关闭（`[live] max_connections = 0`）、不发统计/更新检查/新闻/gravatar/插件预装/外部快照请求。
  公开仪表盘不支持模板变量，本面板也没有；注释（annotations）关闭。
- 管理界面只走 SSH 隧道：`ssh -L 3160:127.0.0.1:3160 <入口机>`，然后打开 `http://127.0.0.1:3160/monitor/`。
- collector 只拉取一个固定 URL；`/metrics` 的查询参数被忽略；不记录响应正文、URL 或客户端地址；失败只按固定原因计数。
  某次拉取失败（或成功结果已过期）时立刻不再输出任何游戏数值（`sp_up 0`），面板显示「—」与「异常」。
- 所有标签不含 IP 或主机名：Prometheus 把 `instance` 改写为 `coordinator` / `edge` / `prometheus`，
  删除 node-exporter 的 `nodename` / `domainname`，丢弃 `device` 中带地址的序列。
- 协调器只对回环/私网客户端返回 `traffic` 字段（`server/http/routes.js`）；collector 经 WireGuard 访问协调器，满足此条件。
- `monitoring.env` 里没有秘密；密码文件不放进仓库、不打印、不计算哈希。

## 3. 部署（入口机）

前提：入口机能经 WireGuard 访问协调器的 `/healthz`；站点 Nginx 已有 127.0.0.1:9145 的 `ark_edge_*` 指标。

```sh
cd deploy/stardust/monitoring          # 或只把本目录复制到入口机，不需要整个仓库
cp monitoring.env.example monitoring.env
# 编辑 monitoring.env：GRAFANA_ROOT_URL=https://<站点>/monitor/，MONITOR_HEALTHZ_URL=协调器隧道地址

# 1) 拉取固定版本镜像，构建 collector
docker compose --env-file monitoring.env -f compose.monitoring.yaml pull node-exporter prometheus grafana
docker compose --env-file monitoring.env -f compose.monitoring.yaml build collector

# 2) Grafana 管理员密码文件：属主 472（镜像内 grafana 用户），0400，不在终端显示
sudo install -d -m 0750 /etc/ark-monitor
sudo sh -c 'umask 077; head -c 32 /dev/urandom | base64 | tr -d "\n=+/" > /etc/ark-monitor/grafana-admin-password'
sudo chown 472:0 /etc/ark-monitor/grafana-admin-password && sudo chmod 0400 /etc/ark-monitor/grafana-admin-password

# 3) 启动并检查
docker compose --env-file monitoring.env -f compose.monitoring.yaml config --quiet
docker compose --env-file monitoring.env -f compose.monitoring.yaml up -d
docker compose --env-file monitoring.env -f compose.monitoring.yaml ps
curl -fsS http://127.0.0.1:9108/metrics | grep -E '^sp_(up|online) '
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up'          # 4 个 job 都应为 1

# 4) 建立（或核对）公开仪表盘，打印访问 token 与路径
sudo GRAFANA_URL=http://127.0.0.1:3160/monitor \
     GRAFANA_ADMIN_PASSWORD_FILE=/etc/ark-monitor/grafana-admin-password \
     GRAFANA_PUBLIC_URL=https://<站点>/monitor/ \
     node publish-dashboard.mjs
```

`publish-dashboard.mjs`（Node ≥ 22，无依赖；入口机没有 Node 时可用
`docker run --rm --network host -v "$PWD/publish-dashboard.mjs:/p.mjs:ro" -v /etc/ark-monitor/grafana-admin-password:/pw:ro -e GRAFANA_ADMIN_PASSWORD_FILE=/pw node:24.22.0-alpine3.24 node /p.mjs`）
是幂等的：第一次创建（share=public、允许选择时间范围、注释关闭），以后只在设置被改动时纠正，token 不变。输出：

```
status=created            # 或 updated / unchanged
dashboard_uid=sp-status
public_dashboard_uid=<uid>
access_token=<32 位十六进制>
public_path=/monitor/public-dashboards/<access_token>
public_url=https://<站点>/monitor/public-dashboards/<access_token>   # 仅在设置 GRAFANA_PUBLIC_URL 时
```

token 本身就是公开地址，可以打印；密码只以 HTTP Basic 发给 `GRAFANA_URL`（明文 http 只允许回环地址）。

5) Nginx：站点模板 `deploy/stardust/nginx/ark-proto.conf` 已带好 `/monitor/` 的 location（只放行
`public-dashboards/`、`api/public/`、`public/` 三个前缀，其余 404；不把 Cookie / Authorization 转给 Grafana；查询 API
每 IP 20 r/s，总并发 48）。`/monitor/` 的跳转目标放在站点目录的 `monitor-entry.conf`，一行：
`return 302 <public_path>;`。另把 `deploy/stardust/nginx/edge-metrics-http.conf`（http 段）和
`edge-metrics-log.conf`（站点 443 server 段）include 进去，提供 127.0.0.1:9145 的 `ark_edge_*`。

Grafana 管理员密码只在**第一次创建数据库**时生效；之后改了文件要同步到数据库（密码从 stdin 读，不进命令行历史）：
`docker compose --env-file monitoring.env -f compose.monitoring.yaml exec -T grafana grafana cli admin reset-admin-password --password-from-stdin < /etc/ark-monitor/grafana-admin-password`。

## 4. 指标

collector（`collector/metrics.mjs` 有完整表格；缺失 / null / 非数字字段不输出，不当作 0；计数器以 `_total` 结尾，
协调器重启后归零，由 `rate()` 处理）：

- 自身：`sp_up`、`sp_scrape_duration_seconds`、`sp_last_success_timestamp_seconds`、`sp_polls_total`、
  `sp_poll_failures_total{reason}`、`sp_info{app,build}`
- 玩家与房间（gauge）：`sp_online`、`sp_sockets`、`sp_sessions`、`sp_rooms`、`sp_matches`、`sp_humans`、`sp_bots`、
  `sp_spectators`、`sp_queued`、`sp_uptime_seconds`、`sp_ok`、`sp_maintenance`、`sp_limit{cap}`、`sp_per_network_peak{kind}`
- 性能（协调器 10 秒窗口，gauge，秒/字节/比例）：`sp_event_loop_delay_seconds{stat=p50|p95|p99|max}`、
  `sp_event_loop_utilization`、`sp_process_cpu_ratio`（1 = 一个核心）、`sp_process_resident_memory_bytes`、
  `sp_heap_used_bytes` 等；`performance.phases` 不导出
- 计数器：`sp_hello_total{outcome}`、`sp_match_seat_departures_total{cause}`、`sp_limit_refusals_total{cap}`、
  `sp_ws_*_total`、`sp_state_*_total`、存档 `sp_checkpoint_*_total` / `sp_lobby_doc_*_total` / `sp_store_*_total`、
  流量 `sp_http_responses_total{class}` / `sp_http_response_bytes_total{class}` / `sp_http_not_modified_total{class}`

recording rules（`prometheus/rules.yml`，面板只读这些和少量 gauge，公开查询很便宜）：`sp:server_up`、
`sp:hello:rate2m`、`sp:store_writes:rate2m`、`sp:checkpoint_failures:rate2m`、`edge:cpu_usage:ratio`、
`edge:memory_usage:ratio`、`edge:network_{transmit,receive}_bits:rate2m`、`edge:requests:rate2m`、
`edge:requests_5xx:ratio2m`。没有告警规则（没有 Alertmanager）。

面板不显示杭州游戏主机的机器指标（那台机器还跑别的业务），只显示协调器进程自身的 CPU/内存。

## 5. 保留、升级与备份

- Prometheus 保留 30 天或 5 GB（先到者生效），数据在命名卷 `ark-monitor_prometheus-data`；Grafana 数据库
  （含公开仪表盘 token）在 `ark-monitor_grafana-data`。**不要运行 `down -v`**。升级镜像前备份这两个卷。
- 修改面板：编辑 `grafana/dashboards/stronghold-status.json`，Grafana 每 60 秒重新读取；界面上的改动不会保存。
- 修改规则或采集配置后重启 Prometheus（未开启 lifecycle API）：`docker compose ... restart prometheus`。
- 网卡不再按名字固定：node-exporter 只排除 lo 和 Docker 的虚拟网卡，带宽面板汇总隧道 `ark-*` 以外的网卡，换机器、
  网卡名变了不用改配置。
- 第二个面板 `grafana/dashboards/stronghold-netq.json`（uid `sp-netq`，「卫戍协议 · 网络质量」）也公开，入口是
  `/monitor/net`。内容是玩家每分钟上报的网络质量（按运营商、省份、设备、连接数，docs/LATENCY.md「Network quality
  reports」）和入口 TCP 重传率；过去 1 小时平均不到 3 个页面的省份 / 运营商不显示。按运营商和省份分需要协调器设
  `SP_ISP_FILE`（docs/DEPLOY.md「多连接」）。发布：同样运行 `publish-dashboard.mjs`，加 `DASHBOARD_UID=sp-netq`，把输出的
  `public_path` 写成站点目录下的 `monitor-net-entry.conf`（`return 302 <public_path>;`，与 `monitor-entry.conf` 同格式），
  再重载 Nginx——这个文件不存在时 `nginx -t` 会失败。

## 6. 验证

```sh
node --test 'deploy/stardust/monitoring/test/*.test.mjs'     # collector、配置与面板、发布脚本
npx eslint deploy/stardust/monitoring
docker run --rm -v "$PWD/deploy/stardust/monitoring/prometheus:/etc/prometheus:ro" --entrypoint promtool \
  prom/prometheus:v3.15.0 check config /etc/prometheus/prometheus.yml
docker run --rm -v "$PWD/deploy/stardust/monitoring/prometheus:/etc/prometheus:ro" --entrypoint promtool \
  prom/prometheus:v3.15.0 check rules /etc/prometheus/rules.yml
curl -fsS http://127.0.0.1:9108/metrics | docker run --rm -i --entrypoint promtool prom/prometheus:v3.15.0 check metrics
```

2026-10-16 已在开发机用本 compose 文件（放进独立网络命名空间）对着假协调器 / 假 OpenResty 指标实测：四个 job 全部
`up`，公开仪表盘只经上述三个前缀即可显示全部面板，协调器失败时显示「异常」与「—」。这不是生产验证。

## 7. 致谢

collector、compose 与 Prometheus 配置改编自 xinhai-ai/Stronghold-Protocol 的 `deploy/monitoring`
（GPL-3.0-or-later），感谢原作者。
