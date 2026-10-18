# 公开素材多源分发

本文说明公开素材分发的实现与安全合同，不记录具体部署坐标或上线状态。以下默认60/40（`--modelscope-weight 100` 为全部普通GET走ModelScope）及可选签名重定向是版本化profile的选择规则，不是某环境的流量或验收声明。实际release、数据集、revision、前缀、挂载摘要及取证保存在Git外的私有发布记录；见[记录边界](releases/README.md)。

## 离线工具的安全合同
- `prepare-material-lb.py` 输出固定小型 `access.lua`／`header.lua` 和 `routes.json`／`header-data.json`（`--signed-ttl` 时另加 `mssign.lua`、`sign.lua`、`sign-location.conf`），以及供 nginx master 预加载库存的 `preload.lua`（见[下文](#master-预加载preloadlua)）；**不再把全量库存编译为 Lua 表**。大型 Lua 表可能触发 LuaJIT 常量上限，`nginx -t` 不能证明运行时filter可执行。必须用实际全量尺寸执行 JSON 解码、缓存和 HTTP filter。
- 默认单前缀、无例外及原 60/40 行为保留；新版本要同时指定 release、40hex revision、primary prefix；公开材料消费者上限为150000 aliases／64MiB输入（0.3.0官方特效与韩语/本土语言配音使库存约13万alias），OpenI最多五个明确审核、固定且去重的mirror目录，保持单／双／三／四目录兼容并拒绝第六个；已有两目录之外只增加固定0.2.3增量目录、0.2.5战场场景增量目录和0.3.0素材增量目录，不提供自动发现或任意host/root/path。ModelScope现有上限仍为八个明确批准的prefix。多前缀以重复 `--modelscope-allowed-prefix` 明示，清单 `prefixes` 必须同序、去重且 primary 在首位；所有 URL 均绑定同一个 revision 和固定公开 repo/origin。
- `--openi-only-path` 仅允许 `/assets/skins/char_340_shwaz_snow_1/illustration.png` 这一精确批准的素材例外，且必须与 MS 清单 `openiOnlyPaths` 一致、存在于 OI 库存。MS alias 集合必须正好为 OI 集合减该例外；普通条目的 bytes／SHA／MIME 逐项一致。未知根字段、额外缺项、其他例外或未认可前缀均拒绝。
- 例外在 routes 中保留为 `false`，只允许该已明示路径直接进入 OI；未知路径的 `nil` 仍拒绝。例外的 header entry 不包含 ModelScope target，因此伪造 MS Location 不能得到公开缓存。JSON 每个 worker 只读取／解码一次（装了 `preload.lua` 则由 master 每次启动／reload 做一次），错误数据也缓存为拒绝，避免重复解析大文件。
- `uploadVerified=true` 仍要求真实 assigned 远端库存证据，不是执行上传命令成功；复用固定 pin 的完整 metadata 审计与全量正文重下载须分别表述。镜像数量限制、私有门禁、签名寿命、CORS、HEAD／OPTIONS／回退合同没有放宽。

准备、远端供给核验和正式切换必须分别授权。离线输出不自动安装入口profile、重建resolver或重启游戏。公开素材的唯一例外不授权改名重传、借旧pin绕过provider限制，或增加其他例外。

## 同字节材料与镜像 pin

游戏、静态回退源、OpenI清单及ModelScope库存必须绑定同一批准release。对象路径可以有相同内容，alias数量不等于对象数量，也不等于唯一内容数。`/assets/audio/` 与 `/media/` 后缀入口继续映射同一源文件，音频远端名无扩展名。

| 源 | 配套要求（不是实际部署坐标） |
|---|---|
| ModelScope | 批准的公开数据集、immutable prefix和完整40hex固定revision，不用可变master |
| OpenI | 最多五个明确审核的固定mirror目录，拒绝第六个；不放宽host/root/path，签名、安全校验、singleflight及有界失败回退见[OPENI.md](OPENI.md) |
| 静态回退源 | 同版本完整目录；可继续供给fonts/vendor/PRTS，普通GET权重0不等于停用 |

解析器容器清单挂载为 `/run/config/openi-assets.json`。宿主来源应使用新revision-suffixed文件，例如 `openi-assets-<SOURCE_REVISION>.json`；必须核对实际mount、完整库存及摘要，不能凭文件名或旧记录推断。

### 远端准备的证据口径

- 分别核对本地文件大小/SHA-256、分页远端库存size及LFS SHA-256、provider审核状态。metadata匹配不等于全部远端正文重下载。
- 对代表性pinned GET正文、HEAD、Range/CORS和完整Spine/音频执行独立检查；浏览器解码成功不等于源站MIME已经正确。
- 旧immutable内容及provider生成的 `.gitattributes` 变化须单独审计，不能将新增元数据或抽样验证描述成远端全部字节未变。
- draft、上传成功、库存匹配、浏览器验收和激活是不同门槛；每一项只记录实际完成的检查，不从其他阶段推断。

## 重定向、CORS与缓存契约

ModelScope分支为：原公开请求URL → 本站302至稳定的 `/datasets/<APPROVED_DATASET>/resolve/<40hex-revision>/<immutable-file>` → provider302至其签名CDN → 正文。正文不穿过入口宿主；serving配置和前端不持有账户Token。

`auth_key` 前导epoch是签发时间，**未证明provider TTL，也不能当OpenI Expires使用**。本站不保存、自行续签或解释临时ModelScope CDN URL；只短缓存稳定pinned下载入口的302，后续跳转由provider控制。provider重定向链的ACAO/ACAC、Vary和最终CDN的公开CORS须单独检查，不能由稳定入口推断。浏览器credentials保持omit/same-origin，不改include，不因素材分流放宽CSP。

Lua仅用于公开 `/assets/`、`/media/` locations：

| 响应 | 本站缓存策略 |
|---|---|
| 已知、精确匹配的稳定ModelScope或同版本静态回退源302 | `public, max-age=60` |
| 已知OpenI签名302 | `public, max-age <= min(60, Expires-now-30)`，不足1秒则no-store |
| 不匹配目标、未知/重复query、不足签名期限、公开错误、OPTIONS | `no-store` |
| 现有named upstream-error fallback | 保留保守 `private, no-store`，不为命中率放宽 |
| 业务代码/data（js/css/shared/sim/data/i18n 的200/304） | 原门禁及 `private, no-cache`（ETag重新验证） |
| 认证、HTML、API、私有401/403等 | 原门禁及 `private, no-store` 不变 |

OpenI目标只接受原Signature V2字段与固定HTTP wrapper `sp_request=cors|display`；不泛化为任意查询字段。公开响应保留/去重 `Vary: Origin, Sec-Fetch-Mode`，且只有一个ACAO `*`、没有Allow-Credentials。已知OPTIONS继续原resolver204，允许GET/HEAD/OPTIONS及Range等原preflight字段；未知OPTIONS404。GET/HEAD之外（OPTIONS除外）405，未知或非法路径404。

**Nginx header filter顺序必须实测**：若目标OpenResty的 `add_header` 在Lua后执行，Lua不能可靠删除之后才追加的继承头。公开location须重复现有HSTS、nosniff、frame、referrer、CSP安全头，却省略Lua管理的Cache-Control/CORS/Vary `add_header`；否则可能重新产生重复Cache-Control或ACAO，或因覆盖继承丢失安全头。私有location不接入这个Lua filter。

仅返回302的服务看不到浏览器之后的全部CDN错误；**不保证任何ModelScope/OpenI下游CDN失败都自动回退**。现有OpenI解析/队列/上游错误回退仍保留，不能将它包装成通用多源熔断引擎。

## Browser failure selector

浏览器只有在公开素材加载失败后才追加一次 `?sp_source=openi`，并从原始本站 alias 发起新请求，绕过已缓存的普通分流 302。`access.lua` 仅接受无查询或这一精确单字段：重复字段、未知字段、其他 source 值、编码变体及空查询均404；已知 alias、safe raw path、方法、同release清单检查仍先行。GET 强制继续现有 OpenI proxy，不改变正常请求的权重或 OpenI-only 例外；HEAD 仍同版本静态回退，OPTIONS 仍原 resolver，其他方法405。选择标记不转发为签名字段，也不能指定任意 URL、provider、镜像目录或版本。

`header.lua` 对强制请求只认可匹配清单的 OpenI/同版本静态回退目标，误回 ModelScope 的 Location 不获得公开短缓存。现有 CORS/Vary 和签名TTL边界保留。不同请求 URL 隔离普通分流与强制跳转的缓存；不加随机 cache-buster，不公开临时签名或把素材正文转发经过游戏节点。

前端和入口profile必须配套发布；只改浏览器、只改解析器，或旧人工权重工具覆盖新 `access.lua` 都不能证明此功能有效。新profile须离线生成、检查实际权重切换工具兼容性，再独立核验/授权安装；提交、合并、推送均不触发安装/reload。原人工切源能力保留为独立操作，浏览器不会永久改变客户端/全站源偏好。raw CSS-only装饰、fonts/vendor及私有请求不由这一客户端加载器处理。它可以捕获客户端观察到的下游失败，但不承诺双源都不可达时仍成功。

本地 opt-in真实 OpenResty 验证：设置 `MATERIAL_OPENRESTY_RUNTIME` 指向已有可用的隔离runtime（包含 `ld-linux-x86-64.so.2`、`openresty/nginx/sbin/nginx`、配套libraries和cjson），执行 `python3 -I deploy/stardust/tools/test-prepare-material-lb.py`。该测试只启动localhost、使用synthetic清单/签名并检查重定向，不跟随 Location 或联系provider；未提供runtime时明确SKIP这一项。浏览器入口与边界见 [ASSETS.md](../../docs/ASSETS.md#browser-public-material-failover)。

## ModelScope 签名重定向（可选 `--signed-ttl`）

`modelscope.cn` 的公开 resolve 地址只走 HTTP/1.1，每次返回带新 `auth_key` 的不可缓存 302。浏览器对同一域名最多 6 条连接，同屏上百个图标会在这一跳排队，触发客户端 8 秒超时后整批切到 OpenI。`--signed-ttl <秒>` 在 profile 中加入 [material-lb/mssign.lua](material-lb/mssign.lua)：入口 OpenResty 对每个对象用内部 HEAD 子请求解析一次，把 CDN 签名地址存在共享内存，浏览器只跟随一次 302 直达 HTTP/2 CDN。

- 只接受 `https://cdn-lfs*.modelscope.cn/prod/lfs-objects/…`、同一 repo／revision、固定查询字段且时间戳与本机相差不超过 120 秒的 type-A `auth_key`。其他回答、出错、冷却或锁等待超时一律回到原公开 resolve 302，与未启用相同。
- `--signed-ttl` 是实测签名有效期的下限（600–3600 秒），不是 provider 承诺。发版用 **3600**：2026-10-17 22:33 起每 10 分钟签一次、共 6 个样本（cdn-lfs-cn-1），每 20 秒 Range 请求一次，4 小时上限内全部有效（之前的 profile 用 720）。剩余不足 300 秒时由一个请求重签，不足 120 秒不再下发；浏览器缓存签名 302 至多 600 秒（2026-10-17 前为 300 秒；改动只对新生成的 profile 生效），并在签名到期前至少 60 秒结束。签不出来时走 OpenI（OSS 签名 302 最多缓存 60 秒）；未启用签名的 profile 仍缓存 86400 秒。
- 不限速：同一对象同一时间只解析一次（`resty.lock`）。上游 403／429／HTML 挑战页冷却 60 秒，连接失败／5xx 冷却 10 秒；200（非 LFS 对象）或 404 使该对象 10 分钟内直接回退。
- 安装时把 [mssign-http.conf](material-lb/mssign-http.conf) 放进 http 上下文，把 [mssign-server.conf](material-lb/mssign-server.conf) 放进运行素材 `access.lua` 的 server。子请求不转发客户端头、Cookie 或正文，并校验证书；签名地址只在共享内存，不写日志、不落盘。共享内存在平滑 reload 后保留，冷重启后清空，首批对象各需解析一次。
- **数据集是私有的（2026-10-18 起）**：公开 resolve 地址对未登录请求返回 404。签名子请求带服主的 ModelScope 登录（`Cookie: m_session_id=<token>`），放在济南 `/opt/ark-cluster-formal/web/ms-auth.conf`（容器内 `/etc/ark-formal/ms-auth.conf`，root 0400，只有 `mssign-server.conf` include，不打印、不进日志、不进 git）。签名 profile 签不出来时（冷启动、冷却、签名模块缺失）改走 OpenI，不再把浏览器送到 resolve 地址；CDN 签名地址本身不需要登录。token 失效时所有素材都会走 OpenI，换 token 后 reload 即可。

### 批量签名（`sign.lua`，2026-10-17）

逐个文件的签名 302 每个约 0.6 KB，rel20 晚高峰约 7900 次/秒、约 40 Mbit/s，是济南出口最大的一项。签名 profile 另外生成 [material-lb/sign.lua](material-lb/sign.lua) 和 `sign-location.conf`：`POST /material-sign`，正文 `{"paths":[alias,…]}`（至多 64 个、16 KiB），回答 `{"urls":{alias:[CDN 签名地址, 剩余秒数]}}`。[public/sw.js](../../public/sw.js) 把本地缓存未命中的路径攒 25 ms 一批去签，然后自己从 CDN 下载并按路径存入 Cache Storage：济南每批只收一个小请求，不再逐个回 302。

- 与逐个 302 共用 `mssign.lua` 的共享内存和锁：同一对象不会因批量而多签。每批最多 8 个并发签名子请求，2.5 秒预算内没签到的、未知的、OpenI 专用的 alias 不出现在回答里，客户端对这些仍走原路径（原 302）。
- 剩余秒数 = 签名时间 + TTL − 120 − 现在；客户端按自己收到回答的时刻再提前 60 秒停用（相对秒数，不受玩家本机时钟影响）。CDN 返回非 200 或下载出错时丢弃该签名，本次走原路径，下次未命中重新签。存进 Cache Storage 的是文件本身，与签名过期无关。
- 端点缺失（404/405）、门禁页或非 JSON 回答：该 worker 10 分钟内不再请求签名；429/5xx/网络错误 30 秒。只接受 `https://cdn-lfs*.modelscope.cn/` 的地址。OpenI 重试（`?sp_source=openi`）和 Range 请求不签名。
- 安装：把本 profile 的 `sign-location.conf` 用 `include` 放进 443 server（与 `/assets/`、`/media/` 同一 profile 目录，换 profile 时一起换）；不加 `auth_request off`，与站点其余部分一样在门禁后面。监控路由类 `sign`（[nginx/edge-metrics-log.conf](nginx/edge-metrics-log.conf)，同步更新线上该文件）。签名地址只出现在回答正文里，不写日志。
- 前提：CDN 回 `Access-Control-Allow-Origin: *`；站点若重新启用 CSP，`connect-src` 需要包含 CDN 域名（原 302 跟随同样需要）。

## Master 预加载（`preload.lua`）

`access.lua`／`header.lua` 在每个 worker 首个公开请求时读取、解码并逐条校验库存。约13万 alias 的完整库存（`routes.json` 约31MB、`header-data.json` 约46MB）在开发机上每次约2.1秒 CPU，其中 `cjson.decode` 只占约0.1秒，其余是校验。这期间该 worker 不处理任何事件，`reuseport` 分到它的新连接在 TLS 握手之前就排队，访问日志里没有记录。reload 后全部新 worker 在首批请求时几乎同时加载，CPU 越少、worker 越多，停顿越长。

- 生成器为每个 profile 另输出 `preload.lua`。其中两段代码由生成器从同一 profile 渲染出的 `access.lua`、`header.lua` 原样截取：`package.loaded` 键、库存路径、校验函数，以及“库存不可读或无效时缓存为 `false`”都相同；另加一行无效时的 ERR 日志 `material preload: invalid … inventory <key>`。截取锚点缺失、重复或顺序不对时生成失败，不会产出偏离的副本。`access.lua`／`header.lua` 本身不变，未装 preload（或 preload 失败）时仍按原样惰性加载；装了则 worker 在 fork 时继承已校验的表，请求路径不再解码。
- vhost 的 http 上下文只能有一个 `init_by_lua*`（[nginx/ark-proto.conf](nginx/ark-proto.conf) 已含空列表的这一块），与现有 geo 的 `init_worker_by_lua_block` 并存。列表写入当前所有 location 正在用的 profile。切换 profile 时，在同一次编辑中把新 profile 的 `preload.lua` 换进列表，旧项随旧 location 一起删除：

  ```nginx
  init_by_lua_block {
      for _, f in ipairs({ "/www/sites/game.example.com/material-lb/EXAMPLE_IMMUTABLE_PROFILE/preload.lua" }) do
          local ok, err = pcall(dofile, f)
          if not ok then ngx.log(ngx.ERR, "material preload: ", err) end
      end
  }
  ```

- master 在启动和每次 HUP／`-s reload` 时执行这一块，加载完才 fork 新 worker，期间旧 worker 照常服务。`nginx -s reload` 发完信号就返回，不代表新 worker 已经起来。OpenResty 在 `nginx -t` 和 `-s` 发信号进程中都不执行 `init_by_lua`，所以 `-t` 不检查 preload。首次启动时这些日志写到 stderr，reload 时写到 error_log。文件缺失、语法错误或运行错误只记日志，该 profile 退回惰性加载，reload 不会失败。reload 后要确认新 worker 已启动，且日志里没有 `material preload:`。
- 内存：master 常驻一份库存（Lua 堆约50–60MiB）。reload 时新旧两份加原始 JSON 同时存在，开发机实测 master 峰值约350MiB RSS。ngx_lua 在每次 `init_by_lua*`／`init_worker_by_lua*` 之后都强制一次完整 GC；worker 启动时的这次 GC 会改写所有继承对象的头部，所以写时复制共享维持不住。开发机实测（16 worker），worker 启动后即有约45MiB 私有内存，有流量后约110MiB PSS；惰性加载的 worker 约165MiB。这次 GC 每个 worker 约20ms CPU，CPU 紧张时 reload 后仍可能有亚秒级短停顿，但不再有逐 worker 数秒的解码停顿。fixture 或开发机数据不能当作生产峰值。

## 版本化实现与离线准备

- [material-lb/access.lua](material-lb/access.lua)：精确alias白名单、raw target验证、HEAD/OPTIONS、ModelScope份额选择（默认60:40，边界2576980378；100%为4294967296）；GET使用request_id前32随机bits，精度误差小于1/2³²；签名profile先取 `mssign.lua` 的CDN重定向。
- [material-lb/mssign.lua](material-lb/mssign.lua)、[mssign-http.conf](material-lb/mssign-http.conf)、[mssign-server.conf](material-lb/mssign-server.conf)：可选签名重定向的模板与入口配置片段。
- [material-lb/sign.lua](material-lb/sign.lua)、[sign-location.conf](material-lb/sign-location.conf)：签名 profile 的批量签名端点（`POST /material-sign`）。
- [material-lb/header.lua](material-lb/header.lua)：精确重定向目标校验、签名寿命限制、公开缓存（稳定ModelScope地址86400秒、签名CDN地址按剩余寿命）及CORS/Vary；未知信息fail-closed到no-store。
- [material-lb/preload.lua](material-lb/preload.lua)：master 预加载模板，由生成器填入从 `access.lua`／`header.lua` 截取的加载代码；vhost 入口见上文 `init_by_lua_block`。
- [tools/prepare-material-lb.py](tools/prepare-material-lb.py)：离线生成批准profile的routes、header data、loader替换及master预加载 `preload.lua`；不联网、不上传、不接触远端、不reload或激活。
- [tools/test-prepare-material-lb.py](tools/test-prepare-material-lb.py)：本地准备器/模板验证入口，不代替实际目标OpenResty与真实浏览器验收。

这些文件版本化固定release/pin与60:40 profile的实现；文档不证明任何输入已经核验。loader安装路径由生成器在固定profile内替换，不等于允许任意provider、权重或游戏release环境变量切换。生成器要求已审批ModelScope manifest的 `uploadVerified=true`；该标记不替代远端库存证据，真实浏览器检查仍是激活前独立门槛。未来材料release须重新审查源manifest、alias、镜像pin、缓存/CORS及真实browser后独立授权；不能把仓库模板或纯同版本静态回退源game-static-locations参考直接覆盖现网。

离线入口示例（在仓库根目录；变量须指向独立核验的Git外材料，无上传/激活；路径仅示例）：

```sh
python3 -I deploy/stardust/tools/test-prepare-material-lb.py
python3 -I deploy/stardust/tools/prepare-material-lb.py \
  --openi-manifest "$VERIFIED_OPENI_MANIFEST" \
  --modelscope-manifest "$VERIFIED_PINNED_MODELSCOPE_MANIFEST" \
  --container-dir /www/sites/game.example.com/material-lb/EXAMPLE_IMMUTABLE_PROFILE \
  --modelscope-weight 100 --signed-ttl 3600 \
  --out "$NEW_OFFLINE_STAGE"
```

## 验证与安全回退

准备器测试、全尺寸Lua/JSON运行、实际目标OpenResty的HTTP filter和真实浏览器解码是不同层级。激活前应验证精确alias库存、未知路径拒绝、随机选择边界、签名寿命、单一缓存/CORS/Vary头、HEAD/OPTIONS/Range及私有门禁。稀疏随机样本不是权重比例或容量证明，fixture RSS不是生产峰值内存。

完整记录应留在本地私有发布目录，保留实际输入/输出摘要和失败证据；公开文档不包含证据路径、环境状态或精确发布JSON。已消费的一次性控制器不能因提交、推送或文档更新而重跑。

若需要紧急同字节回退，先取得明确操作授权并读取**现用**配置/哈希，备份后按CAS/hash校验只合并当前公开location回到已验证的原direct-OpenI形态（或获授权的同版本静态回退源路径），保留所有私有和其他vhost新改动；`nginx -t`后仅平滑reload。不要整份旧vhost覆盖、重启game/auth/proxy/WG、删除immutable镜像或期待恢复内存房间。

后续权重、Beta、多源引擎、材料版本、前端音频变化及清理均需新授权；提交或推送不触发运行时操作。

禁止入库：密码/Cookie、SSH或DNS凭据、verifier、证书/私钥、签名URL query、账户Token、素材/vendor正文及日志内容。实际artifact摘要、固定revision、宿主坐标及完整证据保持在Git外的私有记录；公开示例仅用明确占位符。配套游戏/静态更新与回滚仍遵循 [UPDATE-SOP.md](UPDATE-SOP.md)。
