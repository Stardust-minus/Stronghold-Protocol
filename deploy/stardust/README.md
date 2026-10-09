# 部署覆盖层与运维指南

本目录维护认证/PRTS、Nginx、公开素材分发及配套发布工具，不改变上游项目目录结构。代码遵循仓库 GPL-3.0-or-later；第三方库按原许可证，游戏素材仍受根目录 NOTICE/THIRD-PARTY-NOTICES 限制。

本文是通用指南，不是部署状态、验收回执或执行授权。示例使用 `https://game.example.com`、`https://beta.game.example.com`、`https://assets.example.com` 与 `<占位符>`；具体坐标只放部署者的私有配置。现有工具和模板包含固定 profile、Origin、路径及摘要绑定，不能仅替换示例域名就当作可用部署。

## 架构与发布边界

- **简单部署模板**：`compose.yaml` 为同一 project 的 game/auth/assets 三服务视图；`compose.auth.yaml`、`compose.assets.yaml` 只更新同一服务，不创建另一个 project。普通入口 `/`、WebSocket `/ws` 经过反向代理和门禁，原生监听只供受保护的内部访问。
- **集群部署**：一个 coordinator 管理全局身份、大厅、房间与匹配；game 节点持有完整对局与战斗/试算池；ingress 直接中继所属节点的战斗流。所有入口属于同一个匹配池，不按 DNS 或入口拆分玩家区。固定生成器支持一个 coordinator、十六个各 8 combat + 2 trial 的节点，以及每入口一个或两个 ingress；这是模板规模，不是运行数量声明。
- **Formal 与 Beta 独立**：运行配置、进程、房间、队列、签名密钥、Origin、私有码和租约分别绑定。部署或停用一个环境不授权操作另一个环境。
- **发布线独立**：game、auth/PRTS、resolver、宿主工具和公开素材分别记录身份；源码 HEAD、镜像中的 revision、宿主策略摘要及记录提交不是同一个标识。提交、合并、推送、准备或到达维护窗口都不代表部署许可。
- **内存状态会丢失**：重建 game/coordinator 会失去其内存房间、会话、队列或对局；入口冗余与镜像回滚不能恢复它们。每次中断性操作须明确说明影响并取得用户授权。

详细规范见 [UPDATE-SOP.md](UPDATE-SOP.md)、[CLUSTER-SOP.md](CLUSTER-SOP.md)、[BETA-SOP.md](BETA-SOP.md) 和 [双 ingress 合同](cluster/DUAL-INGRESS.md)。

## 目录导航

| 路径 | 用途 |
|---|---|
| `auth/`、`auth/test/` | 原生 Node 共享口令门禁、PRTS 与隔离安全测试 |
| `compose*.yaml`、`runtime.env.example` | 固定简单部署及独立组件/环境模板；安装前核对实际拓扑 |
| `Dockerfile.offline`、`cluster/Dockerfile.cluster` | 已校验 app 导出目录的离线构建，不能直接把工作树当已固定镜像 |
| `nginx/`、`static/` | 入口代理、精确公开资源路由、静态源缓存/CORS 配置 |
| `openi-resolver/`、[OPENI.md](OPENI.md) | 签名重定向、同版本回退及镜像清单；serving 配置不持有账户 Token |
| [MATERIAL-SOURCES.md](MATERIAL-SOURCES.md)、`material-lb/` | 多源 immutable 素材、宿主 Lua/JSON profile 与缓存边界 |
| `tools/prepare-auth-assets.mjs` | 从匹配依赖和本地字体生成 ignored PRTS 库文件 |
| `tools/prepare-static-release.mjs` | 离线准备/校验公开素材、字体、vendor、音频 alias 与 SHA-256 清单 |
| `tools/prepare-localcode-release.mjs` | 固定源码、精确白名单的私有 JS/CSS 供给，不是公开缓存 |
| `tools/prepare-material-lb.py`、`tools/test-prepare-material-lb.py` | 固定素材 profile 的离线生成/校验，不上传或激活 |
| `tools/cluster-source-export.py`、`tools/cluster-generated-assets.py` | 逐 Git blob 导出及独立 generated renderer resource 清单 |
| `tools/cluster-deploy.py`、`tools/cluster-host-manager.py` | 新受保护 bundle、角色准入、生命周期及精确租约管理 |
| [WORKERS.md](WORKERS.md)、[WS-COMPRESSION.md](WS-COMPRESSION.md) | Worker 健康/故障策略与受控 WS 压缩 |
| [MAIN-THREAD-PRIORITY.md](MAIN-THREAD-PRIORITY.md) | 宿主 Main-only 优先级、固定镜像/源码白名单与停用合同 |
| `tools/main-thread-priority.py`、`systemd/ark-main-thread-priority.service` | 普通调度/reset-on-fork 与 Docker 启动事件保护 |
| [WG-BOOT-RECOVERY.md](WG-BOOT-RECOVERY.md) | WG、关闭护栏及 manager 启动依赖 |
| [releases/README.md](releases/README.md) | 私有发布记录存放规则，不提供站点运行快照 |

## 本地准备与固定构建

先按上游说明准备依赖与素材；已有完整素材时不要重复联网 setup，不在运行主机临时下载或测试。普通开发使用测试秘密文件，不读取真实门禁配置。

```sh
npm ci
node deploy/stardust/tools/prepare-auth-assets.mjs
node --test deploy/stardust/auth/test/*.test.mjs
npm test
```

`prepare-auth-assets.mjs` 不联网，生成文件已忽略；第三方构建产物和游戏美术不提交。需 chown 的凭据权限测试在不支持的环境明确 skip，不能冒称已通过。

简单游戏的构建上下文是新生成目录，内含完整且已校验的 `app/` 与 `Dockerfile.offline`；以下变量必须与 app 内容一致。

```sh
docker build --network=none --pull=false \
  --build-arg SOURCE_REVISION="$SOURCE_REVISION" \
  --build-arg APP_VERSION="$APP_VERSION" \
  -f Dockerfile.offline -t "$IMAGE_TAG" "$NEW_CONTEXT"
```

集群改用 `cluster-source-export.py` 与 `cluster/Dockerfile.cluster`，另绑定 source-kind、source/resource manifest 摘要，详 [CLUSTER-SOP.md](CLUSTER-SOP.md)。auth 构建上下文为 `auth/`，镜像不包含秘密。所有构建、测试和准备命令都不授权安装或重启服务。

## 不可降低的安全合同

1. 保持共享口令、昵称校验、CSRF、可信 Host/Origin、登录限速、private/no-store 与 TLS 安全头。公网内部 health/RPC 端点不可达；不能直接暴露 game/coordinator/ingress/resolver 监听。
2. 公开范围仅为审核过的 assets/fonts/vendor 与 PRTS 稳定库/字体，允许匿名 CORS `*`，不启用 credentials。业务 JS/CSS、data、认证/API/WS 不能因静态分流变为公开资源。
3. game 镜像、私有码、generated renderer index、依赖、公开素材、音频 alias、所有活动 provider pin 和同版本 fallback 必须配套。immutable 目录不覆写；回滚成对恢复。
4. 主机策略默认仅真实 Node MainThread `nice=-20`、普通 `SCHED_OTHER` + reset-on-fork，其他 Worker/V8/libuv/辅助线程均为 0。不 nice 整个进程，不授容器 `CAP_SYS_NICE`，不加 CPU/内存 hard cap；保留 PIDs、read-only、cap-drop、no-new-privileges 等保护。
5. 先关闭护栏，再验证完整 CID/image/source/runtime/网络/进程 generation/角色健康与优先级，最后开放精确租约。漂移、重建或身份不明必须 fail closed；不能全表 flush、放开 Docker 网段或停止被 manager 依赖的 WG recovery 来更新游戏。
6. 只有片头默认跳过；PRTS 组装、界面动效、成功凭证和进入转场保留，减少动画/立即进入兜底仍有效。首次和重入均先验证真实身份、CSRF/profile。配音与其他功能说明见 [VOICE-LANGUAGES](../../docs/VOICE-LANGUAGES.md)。

## 健康与验证口径

game/auth 要按各自 schema 验证；resolver 的内部 loopback `/healthz` 不要求不存在的 `ok` 字段。集群 game 使用认证角色状态，ingress 使用合法 Origin 的 WS upgrade，不能统一套单体 GET health 或 Docker healthy。

game 的 `performance` 为独立缓存：监听成功后约每 10 秒采样，GET/HEAD 不触发采样或 reset；状态区分 `warming/ready/unavailable/stopped`。`windowMs` 取实际单调时长，冷窗口/空统计用 null。主线程 ELU/delay、进程 CPU/RSS 与主线程 heap 口径不同；CPU 一个核满载为 100%，可超过 100%。性能采集失败或 trial 降级不单独改变原健康判定。公网 `/healthz` 仍隐藏，presence 不转发这些诊断。

隔离 Nginx smoke 位于 `nginx/test/simple.test.mjs`，须显式 opt-in 和实际 binary；stock Nginx 无 Lua、原生运行时缺失或环境不支持时明确 skip。单元/mock、真实 HTTP/WS、浏览器渲染、实体设备、完整规模与性能对照是不同证据，不互相代替，不在运行环境压测或清理他人房间。

## 上游同步与记录卫生

只同步上游已正式合并的内容；固定完整 revision 后审查 manifest/lockfile/vendor、新静态路由（含 `/media/`）、WS、昵称/重连、门禁与 Worker 接点。保留失败和 skip，不以库存校验冒称全量远端正文或浏览器验收。

真实发布记录、管理坐标、日志、验收证据及配置备份只放 ignored `.claude/releases/` 或仓库外私有归档，不提交到 `releases/`。禁止提交密码、Cookie、verifier/签名密钥、账户/SSH/DNS 凭据、证书/私钥、签名 URL query、素材/vendor 正文、用户截图或数据导出；ignore 文件只是辅助。证书续期方式和责任人须在私有运维记录中明确，不能把一次 DNS 验证当成自动续期。
