# 游戏与静态资源协同更新 SOP

适用：ark-proto.stardust.matce.cn 游戏、独立 PRTS 门禁，以及 ark-asset.hanabi-ai.cn:25442 静态源。

正式源码目录为 `/root/projects/Stronghold-Protocol`，`origin` 为 Stardust-minus 的 fork、`upstream` 为原作者；本站 `master` 是集成分支。线上基线与仓库 HEAD 分开记录。当前下一次发布目标是 0.1.2 与完成后的 Worker/其他本站改动配套验收后协调上线，提交、合并与推送都不代表允许重启生产。

## 一、发布单元与不可违反的边界

一次游戏发布必须同时记录并核对：

1. 固定的本站 fork 完整 commit，以及其包含的上游基线 commit（不使用会继续变化的分支名作为上线标识）。
2. 由该 commit 构建的游戏镜像标签和镜像 ID。
3. `/assets`、`/fonts`、`/vendor` 对应的静态 release 目录及文件 SHA-256 清单。
4. 该版本的资源 manifest、package-lock、部署适配补丁。
5. 嘉兴 vhost 中上述三个路径指向的同一个静态 release。

目前基线：游戏 `8cd6491e435f0a0355077b6162d1b17b77baa19e` / `0.1.1`，镜像 `ark-proto:8cd6491-20261003`，静态目录 `releases/8cd6491/`。

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

- `fonts/fonts.css`：`url('/fonts/…')` 改为 `url('./…')`，让跨域后的 CSS 相对最终 URL 找到字体。
- `vendor/hooks.module.js`：导入 Preact 的路径统一为 `https://ark-proto.stardust.matce.cn/vendor/preact.module.js`。主游戏也从这个原始 URL 导入，防止重定向后的 hooks 相对新域名再次实例化一份 Preact。该路径返回小型重定向，库正文仍来自宁夏。
- 不盲目批量替换所有字符串或 URL。上游若调整 import 结构，现有适配条件不匹配时停止，重新分析并浏览器验收；不能忽略失败继续发布。
- Three.js 的相对 module/core 引用以及字体 CORS 必须验收。当前公开静态源按用户要求使用 Access-Control-Allow-Origin: *，不启用 Allow-Credentials；还应从无关站点测试匿名 fetch、字体和 Canvas 读取。此设置不代表当前 Preact 适配版 vendor 对所有第三方站点通用。任何 import path 补丁都是发布单元的一部分，不是可丢失的临时修改。
- `gate.js`、`gate.css`、`scene.js`、`entry-nav.js`、登录 HTML、游戏业务 JS/CSS、data、认证接口不放到公开静态源。PRTS 只迁移 Three.js/Core/CSS3D 和字体，不改变页面动作与授权流程。

每个静态文件记录相对路径、字节数、SHA-256。清单保存在 `/opt/ark-static/` 运维目录，不需要对外开放。上传后在宁夏重新逐文件校验，不以 scp 退出码代替完整性校验。

当前参考清单：`asset-manifest.json`、`stable-manifest.json`、`vendor-manifest.json`。归档只允许预期路径，拒绝软链接、硬链接和路径穿越。

## 四、预更新：只上传新版本，不改变线上

1. 将游戏镜像导入嘉兴的新标签，不修改现用 Compose。
2. 将新静态文件上传宁夏的**新目录**，不要覆盖旧版本文件。
3. 为新版本增加静态服务 location / 缓存规则，先 `nginx -t -c /opt/ark-static/nginx.conf`，再平滑 reload。
4. 通过公网 `https://ark-asset.hanabi-ai.cn:25442` 验证：正常 TLS、200/HEAD、Content-Type、CORS、ETag/304、音频 Range/206、错误 no-store、成功 immutable、不能列目录、无代码/秘密文件泄露。
5. 对测试浏览器模拟完整重定向和 CSP，检查实际图形渲染、Spine 配套 SKEL/ATLAS/PNG、OBJ/JSON、音频、字体、Preact hooks 及重复打开时 Three.js 命中缓存。
6. 记录线上游戏/认证容器 ID、PID、StartedAt、restart count，现用 Compose 和 vhost 哈希。预更新结束前再次比对，确认没有动到运行进程。

`3000 → 36.103.203.216:25442` 是平台唯一入站映射，不要改为假定 80/443 可用。新机不依赖 systemd，Nginx 由现有 Supervisor 的独立 `ark-static` 程序管理。

## 五、实际上线：在明确窗口协调切换

1. 用户确认上线后，重新读健康接口与当前配置，不依赖之前保存的对局数量。
2. 正常情况等待无进行中对局并协调在线玩家。只有用户明确要求立即切换并接受清除对局时才例外；记录切换前房间、对局和连接数量。对局在内存中，不能在线迁移或通过镜像回滚恢复。
3. 备份当时的游戏 Compose、vhost、入口 snippet、认证配置及运维说明，记录旧镜像与旧静态前缀。
4. 在同一维护窗口中，将游戏镜像和 `/assets/`、`/fonts/`、`/vendor/` 的重定向 release 一起切到配套版本。先确认所有新静态文件已存在且公网可用，再切游戏；不要在仍有旧对局时提前切换全局素材版本。
5. 该方案不是跨主机原子事务，也不承诺旧客户端与新服务器混用兼容。需要通知客户端刷新，重新加载新业务代码/数据。仅协议版本号不变不能证明兼容。
6. 修改 Nginx 必须先 `nginx -t` 后 `nginx -s reload`。不要为了更新静态路由重启游戏或认证容器；真正升级游戏代码才重建游戏。
7. 除非 PRTS 本身发布，否则保留其独立基础库版本和 CSP，不改变密码、签名密钥或开场动画。
8. 当前游戏 Compose 已删除 CPU/内存限额，后续发布不能拿旧 Compose 覆盖恢复限额。现有进程采用过 cgroup 热解除；按现用 Compose 正常重建后才统一 Docker 元数据。PIDs 与安全选项保留。

## 六、上线验收清单

- 游戏健康 app/revision/image ID 与发布记录一致，两个容器 healthy。
- 新浏览器从正式游戏域名进入，PRTS WebGL/重播/昵称保留正常。
- 登录 HTML、CSRF、POST 授权和退出、游戏数据与代码不能因分流变成公开缓存；无效 Cookie、匿名代码请求仍被拒绝。
- 新静态 origin 只能提供公开资源，不含私钥、认证文件、源代码目录、上传接口。
- 字体/基础库/美术的最终 URL 指向正确 release；没有另一版本目录、404、MIME 或 CORS 错误。
- 热缓存再次进入时 Three.js 大文件来自浏览器缓存；开场仍播放，不用跳过动画来节省流量。
- 双人邀请、刷新重连、server 模式真实对局、棋盘与一次实际购买通过；只清理测试自己的房间。
- 留存浏览器结果、截图、文件清单、配置备份、切换时间和健康信息；不记录密码/Cookie/私钥。

## 七、回滚必须成对

若新版本失败：先判断是否已有新对局并获得相应授权，然后一起恢复**旧游戏镜像 + 旧 assets/fonts/vendor 重定向 release**。只回滚其中一边会造成版本错配。回滚同样不能恢复已经因重启消失的对局。

如果只发生静态源故障且游戏版本没变，可以移除/禁用对应重定向，恢复游戏镜像中自带的同版本本地文件供给；PRTS 库则回到未改动的认证容器副本。只平滑重载 Nginx，无需重启游戏。

回滚时先读取现用配置，合并回退所需段落，不要用整份陈旧备份覆盖其他人的新改动。

## 八、保留与清理

- 至少保留当前和上一完整发布单元；正在供给或可能被旧页面继续引用的静态版本不删除。
- 上线完成后更新两台服务器上的运维说明与 release 清单，并明确哪些版本 active、哪些仅 staged。
- 定期检查磁盘、访问日志轮转、静态源响应码与两个源站的出口流量。
- 证书 2027-01-02 02:34:21 UTC 到期，当前为手动 DNS-01，没有自动续期。续期或 DNS API 委派需单独安排；不要把 A 记录或当次 TXT 值当作自动续期方案。

## 当前管理入口

嘉兴：`/opt/ark-proto/compose.yaml`、`/opt/1panel/www/conf.d/ark-proto.stardust.matce.cn.conf`。
宁夏：`/opt/ark-static/nginx.conf`、`/srv/ark-static/releases/`、`supervisorctl status ark-static`。
证书：宁夏 `/opt/ark-static/tls/`；管理机私有 ACME 备份 `/root/.local/share/ark-static-acme-20261004/`（含私钥，禁止公开或放进静态目录）。
