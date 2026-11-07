# 固定 TREE 的私有代码供给

后续显式profile/commit合同见[formal/README.md](formal/README.md)：现在Beta和Formal均可显式`--source-kind commit`，要求kind=commit、baseRevision=同一完整40hex build、独立完整manifest SHA；默认Beta TREE行为、本站路径/maps/fallback与schema不变。Formal必须`--profile formal`且独立SITE/prefix/maps/coordinator。TREE与commit身份必须分别标注，私有码检查不代表生成资源data已验收。

`sourceKind=tree`表示固定未提交内容快照，不是Git commit；本页不描述某个实际发布。原`prepare-localcode-release.mjs`继续要求真实Git commit并核对Git对象，**不修改、绕过或降低它的默认语义**。`tools/cluster-private-code.py`默认只处理Beta私有JS/CSS（Formal见上；可选运行时静态与前端打包产物见下文），不联网、不执行app、不切vhost、不增加管理API、不接触真实Cookie/key。

## 身份与范围

输入是主发布流程冻结的app目录和`source-manifest.json`：

```json
{"baseRevision":"实际基础Git提交","files":[{"bytes":1,"mode":"0o644","path":"public/js/example.js","sha256":"完整SHA256"}],"kind":"tree","version":1}
```

这是结构说明，不是可运行样例。实际manifest必须满足：

- 精确schema/字段和安全ASCII相对路径，源路径唯一、按路径排序，mode仅0644/0755，bytes为有界整数，SHA256完整64hex。
- 原始bytes必须等于`json.dumps(...,sort_keys=True,ensure_ascii=True,separators=(',',':')) + LF`，拒绝重复JSON key、非canonical编码、未知字段/模式/路径。
- 外部明确提供完整`--manifest-sha256`，`--build`必须是该摘要前40字符，绝不将这个build冒称commit。仅manifest自带摘要不足以建立信任。
- 只对`public/js/**/*.js`及`public/css/**/*.css`建立代码库存；这两个树内的额外文件、map/txt、隐藏文件、未知/空目录、丢文件均拒绝。
- O_NOFOLLOW逐级dir-fd打开文件，拒绝祖先/末端symlink、hardlink、FIFO及其他非普通文件。对读取FD核对inode/size/mtime/ctime/mode，捕获bytes后比较SHA/长度/原mode；复制这一份已验证snapshot，不随后重开源文件。
- 最多4096 source条目/1MiB manifest，单代码文件8MiB、总代码32MiB。源码只读；输出必须是全新不存在目录，已有空目录也拒绝；不允许在源app内部输出。

这里证明**manifest身份/schema及选中的私有码bytes**。没有因此逐文件验证manifest其余runtime、art/fonts/vendor或镜像RootFS；主发布流程另负责那些配套证明。

## 生成与独立校验

```sh
python3 -I deploy/stardust/tools/cluster-private-code.py \
  --source "$FROZEN_APP" --manifest "$FROZEN_SOURCE_MANIFEST" \
  --manifest-sha256 "$SOURCE_MANIFEST_SHA256" --build "$TREE_BUILD" \
  --out "$NEW_PRIVATE_STAGE"

# 校验不需要Git对象，也不需要完整app；仍必须使用独立明确固定的source manifest摘要。
python3 -I deploy/stardust/tools/cluster-private-code.py \
  --verify "$NEW_PRIVATE_STAGE" --manifest "$FROZEN_SOURCE_MANIFEST" \
  --manifest-sha256 "$SOURCE_MANIFEST_SHA256" --build "$TREE_BUILD"
```

输出：

```text
localcode/cluster-<build>/{js,css}/...
nginx/cluster-private-code-beta.conf
release-manifest.json
SHA256SUMS
```

文件0644/目录0755便于Nginx读取，但**没有公开URL前缀**。metadata与SHA256SUMS留在非公开运维位置；业务文件安装位置示例为容器可见`/www/sites/game.example.com/localcode/cluster-<build>/`。vhost继续封锁`/localcode/`，只精确`/js/...js`、`/css/...css`别名能读取。

`--verify`从独立pin的source manifest和当前工具重建全部metadata/include/SHA256SUMS，核对精确输出文件与目录库存、每文件bytes/SHA/mode、preparer SHA；未知/额外/丢文件、伪造metadata、改变include、软硬链接都拒绝。它不会信任输出manifest中自己声称的SHA。

## Nginx访问与stock安全头

生成include只用于Beta TLS server，要求既有`/_gate/check`、`$ark_beta_frame`、`$ark_beta_csp`及server级Origin拒绝规则（Formal为Formal TLS server及`$ark_proto_frame`、`$ark_proto_csp`）。它包括：

- 每个代码URL为精确`location =`、每次`auth_request /_gate/check`、只GET/HEAD、MIME固定、`disable_symlinks on`、`etag on`、`expires off`。
- 已知文件缺失时，**access门禁完成之后**的static404通过`error_page 404 = @ark_beta_cluster_code`进入受保护named fallback。没有`try_files`/rewrite改URI、版本query选择器、无凭据命中或proxy cache。
- 未列出的`/js/`、`/css/`通过受保护prefix location到同一个固定协调器；不允许filesystem wildcard读取，也不继承旧单体/正式上游。
- 三个proxy位置只能指向所选profile批准的唯一coordinator，保留原URI/query。默认WG目标；无WG同机栈用`--topology local`改为该coordinator的core bridge地址`core_ip(2):3000`，metadata仅此时记录`topology`，`--verify`按记录值重建并拒绝不一致的显式`--topology`，见[LOCAL-STACK.md](LOCAL-STACK.md)。目标字段示例为 `http://<APPROVED_COORDINATOR_IP>:<PROFILE_HTTP_PORT>`，不是可执行配置。必须先证明协调器与私有码TREE/commit build及配套release一致；stock版本标识与root runtime build是不同字段，不能凭同端口假定内容匹配。
- proxy覆盖真实IP/转发头，清除未可信Forwarded/CF/Upgrade，隐藏上游CORS/cache/安全头，避免重复或错误策略透传。

Nginx在location增加`add_header`会取消server头继承，因此每个精确alias/prefix/named fallback都重复**stock Beta的七个原始安全表达式**：

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options $ark_beta_frame always;
add_header Referrer-Policy same-origin always;
add_header Cache-Control "private, no-cache" always;
add_header Content-Security-Policy $ark_beta_csp always;
add_header X-Robots-Tag "noindex, nofollow" always;
```

唯一附加诊断是`X-Ark-Code-Source: edge|cluster`。**业务代码不加ACAO，不使用公开素材CORS***。`$ark_beta_csp`保留原表达式：stock默认依赖`$upstream_http_content_security_policy`，本地alias没有upstream时可能为空，Nginx不会输出空CSP头；工具不偷偷发明一个新CSP。若vhost想让业务CSP非空，须在同版本vhost中明确核验map值，不把表达式存在说成实际头一定存在。

include不能和旧同URL exactalias/prefix一起重复加载。安装前独立核对现用vhost，只替换Beta配套私有码include/default受保护HTTP上游，`nginx -t`后正常reload。正式vhost/game/auth、公共素材规则、PRTS动画、旧WG/recovery均不由此工具变更。

## 可选：运行时静态（`--runtime-static`）

默认输出不变（逐字节），只有显式`--runtime-static`时才把协调器的另外三个私有挂载也生成精确alias，使页面加载不再占用coordinator主线程：

- `shared/**/*.js` → `/shared/…`，`server/sim/**/*.js` → `/sim/…`（排除Node专用`nodeData.js`，大小写不敏感），`data/**/*.json` → `/data/…`（排除Git忽略的生成索引`data/local-assets.json`，它仍由coordinator供给）。
- 三个源根必须与manifest在该根下的条目逐一一致（未发布的`.md`等也须列出），只容忍上述生成索引；链接/额外文件/空目录同样拒绝。单文件8MiB、合计48MiB（独立于JS/CSS预算）。
- 每个alias与JS/CSS相同：`auth_request`、仅GET/HEAD、`private, no-cache`（浏览器按ETag重新验证、每次仍过门禁；no-store会让每次页面加载重下全部代码）及全部stock安全头、无业务ACAO、404进入同一受保护fallback；另加`gzip on`与`gzip_types application/javascript application/json`，因为coordinator原本对这些文件gzip。新增`^~ /shared/`、`^~ /sim/`、`^~ /data/`前缀，未知/缺失路径（含`/data/local-assets.json`、`/sim/nodeData.js`、目录301）只代理到同一个coordinator；`/data.js`垫片不受影响，仍走vhost原有位置。
- metadata仅在启用时记录`runtimeStatic:true`；`--verify`按记录值重建，显式`--runtime-static`与记录不符即拒绝。

部署时（需单独授权）：先核对现用vhost没有同URL的`/shared/`、`/sim/`、`/data/`精确或前缀location（否则重复/冲突），确认目标profile与`--topology`，用`--runtime-static`生成并`--verify`，安装到同一`localcode`树，`openresty -t`后正常reload。核验：任一`/data/*.json`与`/shared/*.js`响应带`X-Ark-Code-Source: edge`、`Content-Encoding: gzip`（客户端请求时）、`Cache-Control: private, no-cache`、无ACAO；`/data/local-assets.json`仍为`cluster`；coordinator `/healthz`的`phases.static.data/static.shared`计数应降到接近0。coordinator原路径保留为fallback，回滚只需换回不带`--runtime-static`的include。

## 可选：前端打包产物（`--resource-manifest`，2026-10-16）

`SP_CLIENT=build` 时首页引用 `/build/assets/<name>-<hash8>.js|css`（Vite，`npm run build`）。它们是生成物、不在 source manifest 里：给出同一次导出的 `resource-manifest.json` 及其 SHA-256（`--resource-manifest`、`--resource-manifest-sha256`，prepare 与 `--verify` 都要给），工具只选 `public/build/assets/` 下名字带内容哈希的 `.js`/`.css`，核对导出目录里该目录恰好是这些文件、字节一致，生成同样过门禁的精确 alias（`Cache-Control: private, max-age=31536000, immutable`，gzip），另加 `^~ /build/` 回落到同一 coordinator。`/build/index.html` 与 `/` 不做 alias（协调器返回，重新验证）。metadata 只在启用时记录 `clientBuildResourceManifestSha256`，`--verify` 必须给出同一份 resource manifest。

`data/local-fx.json`（0.3.0 官方特效清单，像 `local-assets.json` 一样是 ignored 的生成文件）存在时由 `cluster-source-export.py` 校验 schema/路径（`/assets/local/fx/…`，特效文件本身由素材源提供，不进镜像）后作为 `generated-fx-data` 资源导出；`--runtime-static` 不为它生成 alias，`/data/local-fx.json` 由协调器提供。

## 验证入口与边界

准备器回归应覆盖schema、canonical输入、链接、目录、输出库存及stock安全头表达式。隔离Nginx HTTP检查应覆盖body/SHA/MIME、单值安全头、private-no-cache/no-CORS、HEAD/授权304、匿名条件请求仍401、POST405、异源403、未知/缺文件fallback及匿名缺文件不触发取代码。

fixture auth header不是真实密码/CSRF/TLS验收；本地stage及 `--verify` 不证明已安装、激活或完整资源匹配。实际输入摘要和验证结果保存在Git外的私有发布记录，见[记录边界](../releases/README.md)。

运行：

```sh
python3 -I deploy/stardust/tools/test_cluster_private_code.py
CLUSTER_PRIVATE_CODE_HTTP=1 python3 -I deploy/stardust/tools/test_cluster_private_code_http.py
```

HTTP测试使用隔离Nginx runtime；可显式提供`CLUSTER_CODE_NGINX`、`CLUSTER_CODE_LOADER`、`CLUSTER_CODE_LIBS`，这些应来自已验证材料，不执行未知下载cwd的binary/build。所有监听只127.0.0.1，PIDs/temp/server均为owned fixture，测试结束清理。
