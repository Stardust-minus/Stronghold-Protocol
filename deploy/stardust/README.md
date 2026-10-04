# Stardust 部署覆盖层

本目录版本化维护本站的认证/PRTS、Nginx、公开静态源和协同发布流程，不改变上游的项目目录结构。代码遵循仓库 GPL-3.0-or-later；第三方库按原许可证，游戏素材仍受根目录 NOTICE/THIRD-PARTY-NOTICES 的限制。

## 仓库与生产是两件事

- `origin`：`git@github.com:Stardust-minus/Stronghold-Protocol.git`。
- `upstream`：`git@github.com:sganggs/Stronghold-Protocol.git`。
- 本 fork 的 `master` 是本站集成分支；功能分支验证后合并，不强推或改写已发布历史。
- 固定本地工作目录：`/root/projects/Stronghold-Protocol`。旧 `/tmp` 工作目录只作历史参考，不再作为开发主目录。
- 本目录初始化时，线上运行 `8cd6491` / `0.1.1`。本次配置的目标发布单元为 `v012-workers-20261004`（上游 0.1.2 + 固定战斗 Worker 池 + `/media/` 静态适配），**配置准备不等于已经切换生产**。
- 实际激活状态以两机 release 记录为准。checkout、合并与推送不自动授权部署；须完成同一 commit 的本地验收并取得上线授权，才能协调切换游戏与静态路由。

## 内容

| 路径 | 用途 |
|---|---|
| `auth/` | 原生 Node 共享口令认证服务和主助手编写的 PRTS 前端 |
| `auth/test/` | 不接触生产的认证、CSRF、限速及凭据文件权限测试 |
| `compose.yaml` | 游戏目标配置；`SP_COMBAT=server`、4 Worker，无 CPU/内存硬上限，PIDs/安全限制保留 |
| `compose.auth.yaml` | 独立门禁服务，保留 0.5 CPU / 256 MiB 限制 |
| `Dockerfile.offline` | 使用已准备好的 `app/` 目录离线构建，需传入实际 commit/version |
| `nginx/` | 嘉兴 OpenResty vhost 和开场导航 snippet |
| `static/` | 宁夏公开静态源 Nginx 与 Supervisor 配置，10 workers；CORS `*`，无凭据 |
| `tools/prepare-auth-assets.mjs` | 从本仓库 lockfile 对应依赖和已安装字体准备 PRTS 的忽略文件 |
| `tools/prepare-static-release.mjs` | 离线准备/校验素材、字体、vendor、音频 alias 和逐文件 SHA-256 清单 |
| `WORKERS.md` | Worker 边界、故障策略、回退、健康指标与本机性能样本 |
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

## Worker 开发状态

固定池已实现，`SP_COMBAT_WORKERS=0` 保留原后端，生产目标为 4 Worker；不引入 Redis，不改变前端协议。`maxRooms` 默认 4096。确定性、Boss 共享池、暂停在途回包、动态元数据重连、退出/取消、迟到消息、线程故障与关闭均有专门测试。详细范围、故障行为和容量限制见 [WORKERS.md](WORKERS.md)，实际线上启用状态仍须核对 release 记录及 `/healthz`。
