# 公开素材多源分发

本文说明公开素材分发的实现与安全合同，不记录具体部署坐标或上线状态。以下60/40是版本化profile的选择规则，不是某环境的流量或验收声明。实际release、数据集、revision、前缀、挂载摘要及取证保存在Git外的私有发布记录；见[记录边界](releases/README.md)。

## 离线工具的安全合同
- `prepare-material-lb.py` 输出固定小型 `access.lua`／`header.lua` 和 `routes.json`／`header-data.json`；**不再把全量库存编译为 Lua 表**。大型 Lua 表可能触发 LuaJIT 常量上限，`nginx -t` 不能证明运行时filter可执行。必须用实际全量尺寸执行 JSON 解码、缓存和 HTTP filter。
- 默认单前缀、无例外及原 60/40 行为保留；新版本要同时指定 release、40hex revision、primary prefix；公开材料消费者上限为100000 aliases／64MiB输入，OpenI最多三个明确审核、固定且去重的mirror目录，保持单／双目录兼容并拒绝第四个；本次只增加已有两目录之外的固定0.2.3增量目录，不提供自动发现或任意host/root/path。ModelScope现有上限仍为八个明确批准的prefix。多前缀以重复 `--modelscope-allowed-prefix` 明示，清单 `prefixes` 必须同序、去重且 primary 在首位；所有 URL 均绑定同一个 revision 和固定公开 repo/origin。
- `--openi-only-path` 仅允许 `/assets/skins/char_340_shwaz_snow_1/illustration.png` 这一精确批准的素材例外，且必须与 MS 清单 `openiOnlyPaths` 一致、存在于 OI 库存。MS alias 集合必须正好为 OI 集合减该例外；普通条目的 bytes／SHA／MIME 逐项一致。未知根字段、额外缺项、其他例外或未认可前缀均拒绝。
- 例外在 routes 中保留为 `false`，只允许该已明示路径直接进入 OI；未知路径的 `nil` 仍拒绝。例外的 header entry 不包含 ModelScope target，因此伪造 MS Location 不能得到公开缓存。JSON 只读取／解码一次，错误数据也缓存为拒绝，避免重复解析大文件。
- `uploadVerified=true` 仍要求真实 assigned 远端库存证据，不是执行上传命令成功；复用固定 pin 的完整 metadata 审计与全量正文重下载须分别表述。镜像数量限制、私有门禁、签名寿命、CORS、HEAD／OPTIONS／回退合同没有放宽。

准备、远端供给核验和正式切换必须分别授权。离线输出不自动安装入口profile、重建resolver或重启游戏。公开素材的唯一例外不授权改名重传、借旧pin绕过provider限制，或增加其他例外。

## 同字节材料与镜像 pin

游戏、静态回退源、OpenI清单及ModelScope库存必须绑定同一批准release。对象路径可以有相同内容，alias数量不等于对象数量，也不等于唯一内容数。`/assets/audio/` 与 `/media/` 后缀入口继续映射同一源文件，音频远端名无扩展名。

| 源 | 配套要求（不是实际部署坐标） |
|---|---|
| ModelScope | 批准的公开数据集、immutable prefix和完整40hex固定revision，不用可变master |
| OpenI | 最多三个明确审核的固定mirror目录，拒绝第四个；不放宽host/root/path，签名、安全校验、singleflight及有界失败回退见[OPENI.md](OPENI.md) |
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
| 认证、业务代码/data、私有401/403等 | 原门禁及 `private, no-store` 不变 |

OpenI目标只接受原Signature V2字段与固定HTTP wrapper `sp_request=cors|display`；不泛化为任意查询字段。公开响应保留/去重 `Vary: Origin, Sec-Fetch-Mode`，且只有一个ACAO `*`、没有Allow-Credentials。已知OPTIONS继续原resolver204，允许GET/HEAD/OPTIONS及Range等原preflight字段；未知OPTIONS404。GET/HEAD之外（OPTIONS除外）405，未知或非法路径404。

**Nginx header filter顺序必须实测**：若目标OpenResty的 `add_header` 在Lua后执行，Lua不能可靠删除之后才追加的继承头。公开location须重复现有HSTS、nosniff、frame、referrer、CSP安全头，却省略Lua管理的Cache-Control/CORS/Vary `add_header`；否则可能重新产生重复Cache-Control或ACAO，或因覆盖继承丢失安全头。私有location不接入这个Lua filter。

仅返回302的服务看不到浏览器之后的全部CDN错误；**不保证任何ModelScope/OpenI下游CDN失败都自动回退**。现有OpenI解析/队列/上游错误回退仍保留，不能将它包装成通用多源熔断引擎。

## 版本化实现与离线准备

- [material-lb/access.lua](material-lb/access.lua)：精确alias白名单、raw target验证、HEAD/OPTIONS、60:40选择；GET使用request_id前32随机bits，边界2576980378，精度误差小于1/2³²。
- [material-lb/header.lua](material-lb/header.lua)：精确重定向目标校验、签名寿命限制、公开短缓存及CORS/Vary；未知信息fail-closed到no-store。
- [tools/prepare-material-lb.py](tools/prepare-material-lb.py)：离线生成批准profile的routes、header data及loader替换；不联网、不上传、不接触远端、不reload或激活。
- [tools/test-prepare-material-lb.py](tools/test-prepare-material-lb.py)：本地准备器/模板验证入口，不代替实际目标OpenResty与真实浏览器验收。

这些文件版本化固定release/pin与60:40 profile的实现；文档不证明任何输入已经核验。loader安装路径由生成器在固定profile内替换，不等于允许任意provider、权重或游戏release环境变量切换。生成器要求已审批ModelScope manifest的 `uploadVerified=true`；该标记不替代远端库存证据，真实浏览器检查仍是激活前独立门槛。未来材料release须重新审查源manifest、alias、镜像pin、缓存/CORS及真实browser后独立授权；不能把仓库模板或纯同版本静态回退源game-static-locations参考直接覆盖现网。

离线入口示例（在仓库根目录；变量须指向独立核验的Git外材料，无上传/激活；路径仅示例）：

```sh
python3 -I deploy/stardust/tools/test-prepare-material-lb.py
python3 -I deploy/stardust/tools/prepare-material-lb.py \
  --openi-manifest "$VERIFIED_OPENI_MANIFEST" \
  --modelscope-manifest "$VERIFIED_PINNED_MODELSCOPE_MANIFEST" \
  --container-dir /www/sites/game.example.com/material-lb/EXAMPLE_IMMUTABLE_PROFILE \
  --out "$NEW_OFFLINE_STAGE"
```

## 验证与安全回退

准备器测试、全尺寸Lua/JSON运行、实际目标OpenResty的HTTP filter和真实浏览器解码是不同层级。激活前应验证精确alias库存、未知路径拒绝、随机选择边界、签名寿命、单一缓存/CORS/Vary头、HEAD/OPTIONS/Range及私有门禁。稀疏随机样本不是权重比例或容量证明，fixture RSS不是生产峰值内存。

完整记录应留在本地私有发布目录，保留实际输入/输出摘要和失败证据；公开文档不包含证据路径、环境状态或精确发布JSON。已消费的一次性控制器不能因提交、推送或文档更新而重跑。

若需要紧急同字节回退，先取得明确操作授权并读取**现用**配置/哈希，备份后按CAS/hash校验只合并当前公开location回到已验证的原direct-OpenI形态（或获授权的同版本静态回退源路径），保留所有私有和其他vhost新改动；`nginx -t`后仅平滑reload。不要整份旧vhost覆盖、重启game/auth/proxy/WG、删除immutable镜像或期待恢复内存房间。

后续权重、Beta、多源引擎、材料版本、前端音频变化及清理均需新授权；提交或推送不触发运行时操作。

禁止入库：密码/Cookie、SSH或DNS凭据、verifier、证书/私钥、签名URL query、账户Token、素材/vendor正文及日志内容。实际artifact摘要、固定revision、宿主坐标及完整证据保持在Git外的私有记录；公开示例仅用明确占位符。配套游戏/静态更新与回滚仍遵循 [UPDATE-SOP.md](UPDATE-SOP.md)。
