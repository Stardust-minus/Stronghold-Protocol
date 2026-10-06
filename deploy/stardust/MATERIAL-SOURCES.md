# 公开素材多源分发

## 当前正式活动状态（2026-10-06）

- **17:12:58 +08 激活，17:19:54 +08 完成验收**：正式公开 `/assets/`、`/media/` 普通 GET 为 **ModelScope 60% / OpenI 40% / 宁夏 0%**。这是每请求随机选择，不是严格6/10轮转、玩家配额或出口字节占比；短缓存会复用已选中的302。
- 宁夏仍是 HEAD 元数据目的地及**原 OpenI 失败回退**，并继续供给 fonts/vendor/PRTS 正文。Beta 分流、私有代码/data/认证/WS、root hooks 直接游戏的例外均未改变。
- 正式游戏仍为 `7e019ee36a2423393221cbba37bf60e40be35536` / image `10c94333` / CID `8715f3a3`；Beta 仍为 C1 `1f742992` / image `14ad2e07` / CID `dd114e05`。两者12 combat + 2 trial、healthy、restart0，游戏代次/StartedAt/内存对局未改变。Main-only nice=-20、SCHED_OTHER/reset-on-fork及其他线程0保持，核查为只读。
- Resolver 仍是 source `063550652867c0c69a193156b77e6f67316f685f` / image `53ac7717`，auth 仍source `186cda7d088f2f17e9dd402ae864258e6c72cef8` / image `5fa043dd`。多源选择和短缓存是**宿主 Nginx/Lua**，不是这些镜像的新功能。只有平滑 Nginx reload，没有容器、game/auth/resolver、WG或管理器重启。
- 当前正式vhost SHA-256：`cefc036ffbf804c96294b66837a564f5e731172e8e40c897c903a270bbf68e06`。全局Nginx `397db9bc…`、Beta vhost `4c8fb2d5…`、原resolver snippet `2492b897…` 均未变。

活动记录：[v013-material-lb-20261006-modelscope60-openi40.json](releases/v013-material-lb-20261006-modelscope60-openi40.json)。其中游戏 `sourceHash`/`sourceRevision` 是实际运行源码，不是后续记录提交的 Git HEAD；配置文件的SHA-256也不等于Git commit。历史发布JSON不改写。

## 同字节材料与镜像 pin

本批复用 C1 静态单元 **`v013-hangzhou-20261006-1f742992`**，没有游戏美术、音频、vendor或玩法字节更新。精确库存为 **7200对象 / 7049唯一SHA-256内容 / 403852758字节 / 24968请求alias**。不同对象路径可以有相同内容；不能把7200说成唯一内容数，也不能把alias数当上传对象数。`/assets/audio/` 与 `/media/` 的后缀入口继续映射同一源文件，音频远端名无扩展名。

| 源 | 当前职责与固定坐标 |
|---|---|
| ModelScope | 公开数据集 `Stardust/arknight-assets`；immutable前缀 `releases/v013-modelscope-20261006-1f742992-174200`；固定远端revision `34fa98b056c7554b8dbea7a4e18e78b6c6445fbb`，不用可变master |
| OpenI | 继续原resolver及已验证C1多mirror清单；签名、安全校验、singleflight及有界失败回退见 [OPENI.md](OPENI.md)；此次未重建或上传OpenI |
| 宁夏 | 同版本完整fallback `https://ark-asset.hanabi-ai.cn:25442/releases/v013-hangzhou-20261006-1f742992`，并保留fonts/vendor/PRTS；普通GET的正常选择权重0不等于停用此源 |

实际 resolver mount 是容器 `/run/config/openi-assets.json`，宿主源为：

`/opt/ark-proto/openi-resolver/openi-assets-1f74299291f07e100ca6f522721a29d4c474294c.json`

SHA-256 `b144d019275956c328740dd677a4a328d9b16fa87ebabd710f1cd55e8de07cbc`。宿主无后缀 `openi-assets.json` 是历史清单，不是当前挂载；必须核对实际mount及完整路径库存，不能凭文件名或旧记录推断。

### ModelScope全量准备的证据口径

- 全部本地文件大小/SHA-256已核对；分页远端库存全部size及LFS SHA-256匹配，全部 `InCheck=false`。**没有全部重下载远端正文**。
- 8个代表性 pinned HTTP GET正文哈希、HEAD、Range206/CORS通过，包含完整Spine及SFX/voice；随后独立真实浏览器验证。
- 旧6个材料探针、README、ZIP共8个历史文件保持byte-identical，没有覆盖或删除。Provider typed-LFS提交自动将 `.gitattributes` 从4047扩至449226字节：旧字节前缀/规则精确保留，仅3300条新白名单材料规则，未知新增0、删除0。它是单独审计的**provider元数据变化**，不能声称整个远端仓库元数据完全未变，也不是手工覆写。
- 准备receipt当时标记 `not-activated`/`browserVerified=false` 是历史阶段状态；后续Chrome及17:19 completion证据完成对应门槛，不能把早期阶段标记当作最新未上线结论。

## 重定向、CORS与缓存契约

ModelScope分支为：原公开请求URL → 本站302至稳定的 `/datasets/Stardust/arknight-assets/resolve/<40hex-revision>/<immutable-file>` → provider302至其签名CDN → 正文。正文不穿过嘉兴；serving配置和前端不持有账户Token。

`auth_key` 前导epoch是签发时间，**未证明provider TTL，也不能当OpenI Expires使用**。本站不保存、自行续签或解释临时ModelScope CDN URL；只短缓存稳定pinned下载入口的302，后续跳转由provider控制。API实际反射Origin的ACAO/ACAC并有VaryOrigin，最终CDN为CORS `*`；真实Chrome匿名链路（含重定向污染Origin）通过。浏览器credentials保持omit/same-origin，不改include，不为本批放宽CSP。

Lua仅用于公开 `/assets/`、`/media/` locations：

| 响应 | 本站缓存策略 |
|---|---|
| 已知、精确匹配的稳定ModelScope或宁夏302 | `public, max-age=60` |
| 已知OpenI签名302 | `public, max-age <= min(60, Expires-now-30)`，不足1秒则no-store |
| 不匹配目标、未知/重复query、不足签名期限、公开错误、OPTIONS | `no-store` |
| 现有named upstream-error fallback | 保留保守 `private, no-store`，不为命中率放宽 |
| 认证、业务代码/data、私有401/403等 | 原门禁及 `private, no-store` 不变 |

OpenI目标只接受原Signature V2字段与固定HTTP wrapper `sp_request=cors|display`；不泛化为任意查询字段。公开响应保留/去重 `Vary: Origin, Sec-Fetch-Mode`，且只有一个ACAO `*`、没有Allow-Credentials。已知OPTIONS继续原resolver204，允许GET/HEAD/OPTIONS及Range等原preflight字段；未知OPTIONS404。GET/HEAD之外（OPTIONS除外）405，未知或非法路径404。

**Nginx header filter顺序必须实测**：当前目标OpenResty中 `add_header` 在Lua后执行，Lua不能可靠删除之后才追加的继承头。公开location须重复现有HSTS、nosniff、frame、referrer、CSP安全头，却省略Lua管理的Cache-Control/CORS/Vary `add_header`；否则可能重新产生重复Cache-Control或ACAO，或因覆盖继承丢失安全头。私有location不接入这个Lua filter。

仅返回302的服务看不到浏览器之后的全部CDN错误；**不保证任何ModelScope/OpenI下游CDN失败都自动回退**。现有OpenI解析/队列/上游错误回退仍保留，不能将它包装成通用多源熔断引擎。

## 版本化实现与离线准备

- [material-lb/access.lua](material-lb/access.lua)：精确alias白名单、raw target验证、HEAD/OPTIONS、60:40选择；GET使用request_id前32随机bits，边界2576980378，精度误差小于1/2³²。
- [material-lb/header.lua](material-lb/header.lua)：精确重定向目标校验、签名寿命限制、公开短缓存及CORS/Vary；未知信息fail-closed到no-store。
- [tools/prepare-material-lb.py](tools/prepare-material-lb.py)：离线生成当前C1/profile的routes、header data及loader替换；不联网、不上传、不接触远端、不reload或激活。
- [tools/test-prepare-material-lb.py](tools/test-prepare-material-lb.py)：本地准备器/模板验证入口，不代替实际目标OpenResty与真实浏览器验收。

这些文件只版本化**当前已验证C1、ModelScope pin与60:40 profile**。loader安装路径由生成器在固定profile内替换，不等于允许任意provider、权重或游戏release环境变量切换。生成器要求已审批ModelScope manifest的 `uploadVerified=true`；该标记不替代远端库存证据，Chrome仍是激活前独立门槛。未来材料release须重新审查源manifest、alias、镜像pin、缓存/CORS及真实browser后独立授权；不能把本批模板或纯宁夏game-static-locations参考直接覆盖现网。

离线入口（在仓库根目录；manifest来自已核验的Git外材料，无上传/激活）：

```sh
python3 -I deploy/stardust/tools/test-prepare-material-lb.py
python3 -I deploy/stardust/tools/prepare-material-lb.py \
  --openi-manifest "$VERIFIED_C1_OPENI_MANIFEST" \
  --modelscope-manifest "$VERIFIED_PINNED_MODELSCOPE_MANIFEST" \
  --container-dir /www/sites/ark-proto.stardust.matce.cn/material-lb/20261006-379e9de058 \
  --out "$NEW_OFFLINE_STAGE"
```

主助手本批本地11项unit tests通过；使用完整24968真实alias清单及已接受的loader目录离线重生成，**四个文件均复现下表实际live SHA-256**。这证明版本化准备器可重现当前profile，不触发部署；本次推送准备没有重跑全game canonical，也没有新增live操作。

线上immutable宿主目录：

`/opt/1panel/www/sites/ark-proto.stardust.matce.cn/material-lb/20261006-379e9de058/`

容器loader目录为相同后缀的 `/www/sites/ark-proto.stardust.matce.cn/material-lb/20261006-379e9de058/`。线上SHA-256：

| 文件 | 字节数（已记录者） | SHA-256 |
|---|---:|---|
| routes.json | 6094985 | `6a91e9bcead2c53d23aa9031f3b319eb71abb79921f183d7921b679e948e84d7` |
| access.lua | — | `2f3988a430ca868746a8700a3585d8f4c4c14f9bc8cf0308bbb29fb2eebf13ad` |
| header.lua | — | `c02076d98a4bcbaeabc42881e2272338d980110a8bfd76a0e8224d9fd51371ef` |
| header-data.lua | 8955119 | `f7cb40a0c62a5619de8a1adaca7c9bb4673b40787f798625b15203996018a37d` |

以上是**已安装文件**摘要；带loader占位符的仓库模板不能冒称具有相同哈希。路由/数据在每worker首次载入后复用，不逐请求读文件或秘密。全数据测试匹配24968目的地，fixture worker RSS约28MiB，不是生产峰值内存或容量承诺。

## 已完成验收与明确未验收项

历史隔离fixture使用与生产相同的OpenResty1.27.1.2/ngx_lua0.10.28，仅复制binary/libs，未复制站点、证书或秘密：

- 初次50:50：HTTP262请求/2110断言，header21组/1522断言，access471断言；兼容性补充后HTTP281/2215、header23组/1616、access495，全部通过。
- 最终60:40：真实HTTP133请求/1020断言，全数据Lua25234断言，0失败；100固定中点ID为60/40/0，100随机ID为62/38/0。没有生产压力测试。
- 17:14实际公网30个稀疏GET：13 ModelScope / 17 OpenI / 0宁夏，全部302、单一public60 Cache-Control、单CORS/单Vary、精确ModelScope pin。小样本不是“实测60%”。另9项检查通过：HEAD宁夏、已知OPTIONS204、未知GET/OPTIONS404、POST405、匿名代码/root401、无关Origin403、public health404。
- 主助手Chrome隐身、实际游戏HTTPS origin、无认证Cookie/无房间：直接ModelScope及live混合来源各4份body hash/200通过，voice解码6.764979秒、完整Spine25骨骼/10动画通过；live画面1053可见像素。game-root CSP此前确认未设置，无需放宽。
- audio仍可能是generic binary MIME，AudioContext能解码；没改前端audio fallback，**不声称已解决初次双fetch**。本批没有实际密码输入或玩法验收，也没有重复Beta玩法验收。

## 证据、历史与安全回退

忽略目录仅用于本地/私有运维取证，不提交文件内容：

- `.cache/stardust/material-lb-final-20261006-379e9de058/`：stage、activation、public-final-acceptance、game-final、completion JSON。
- `.cache/stardust/modelscope-full-20261006-174200/`：upload/readiness、serving manifest、provider元数据证明及direct/live browser JSON。
- `.cache/stardust/material-lb-fixture-lua-20261006-sCWmy8/results/`：初始失败及各阶段通过结果均保留。
- 远端私有最终receipt/backup：`/data/ark-proto/material-lb-maintenance-20261006-379e9de058/{receipt.json,before-vhost}`，phase `complete-accepted`，目录0700/文件0600。

**历史16:50初次50:50**使用 `20261006-b699d044b0`，vhost `a314…`；当时固定sp_request未纳入公开缓存校验且OPTIONS被拒，已在最终profile修复，不能把初次Lua当首选最终回滚。原pre-LB `5e123d68…` vhost备份位于 `/data/ark-proto/material-lb-maintenance-20261006-b699d044b0/before-vhost`，不是当前vhost。早期NUL pattern问题在本地捕获修复，未造成生产500；错误历史manifest路径的preflight在写入前停止，随后核对实际mount。上传中断、已存OID以hash/size证明恢复、provider元数据差异均保留取证，不抹去失败历史。

若需要紧急同字节回退，先取得明确操作授权并读取**现用**配置/哈希，备份后按CAS/hash校验只合并当前公开location回到已验证的原direct-OpenI形态（或获授权的同版本宁夏路径），保留所有私有和其他vhost新改动；`nginx -t`后仅平滑reload。不要整份旧vhost覆盖、重启game/auth/proxy/WG、删除immutable镜像或期待恢复内存房间。

已完成 `deploy-material-lb-20261006.py` / `activate-material-model60-20261006.py` 为一次性操作，其preconditions已失效，**不得盲目重跑**。后续权重、Beta、多源引擎、材料版本、前端音频变化及清理均需新授权；本次提交/推送不触发任何live操作。

禁止入库：密码/Cookie、SSH或DNS凭据、verifier、证书/私钥、签名URL query、账户Token、素材/vendor正文及日志内容。可记录公开artifact hash、固定revision和必要host-only路径；秘密及完整证据保持Git外。配套游戏/静态更新与回滚仍遵循 [UPDATE-SOP.md](UPDATE-SOP.md)。
