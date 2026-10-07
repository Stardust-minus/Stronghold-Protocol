# 固定 TREE 的 Beta 私有代码供给

后续显式profile/commit合同见[formal/README.md](formal/README.md)：现在Beta和Formal均可显式`--source-kind commit`，要求kind=commit、baseRevision=同一完整40hex build、独立完整manifest SHA；默认Beta TREE行为、本站路径/maps/fallback与schema不变。Formal必须`--profile formal`且独立SITE/prefix/maps/coordinator。下方TREE证据保留为历史，不冒称本次commit或生成资源data已验收。

本批应用是明确标注`sourceKind=tree`的固定未提交内容快照，不是Git commit。原`prepare-localcode-release.mjs`继续要求真实Git commit并核对Git对象，**不修改、绕过或降低它的默认语义**。新`tools/cluster-private-code.py`只处理Beta私有JS/CSS，不联网、不执行app、不切vhost、不增加管理API、不接触真实Cookie/key。

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

文件0644/目录0755便于Nginx读取，但**没有公开URL前缀**。metadata与SHA256SUMS留在非公开运维位置；实际业务文件放到容器可见`/www/sites/ark-proto-beta.stardust.matce.cn/localcode/cluster-<build>/`。vhost继续封锁`/localcode/`，只精确`/js/...js`、`/css/...css`别名能读取。

`--verify`从独立pin的source manifest和当前工具重建全部metadata/include/SHA256SUMS，核对精确输出文件与目录库存、每文件bytes/SHA/mode、preparer SHA；未知/额外/丢文件、伪造metadata、改变include、软硬链接都拒绝。它不会信任输出manifest中自己声称的SHA。

## Nginx访问与stock安全头

生成include只用于Beta TLS server，要求既有`/_gate/check`、`$ark_beta_frame`、`$ark_beta_csp`及server级Origin拒绝规则。它包括：

- 每个代码URL为精确`location =`、每次`auth_request /_gate/check`、只GET/HEAD、MIME固定、`disable_symlinks on`、`etag on`、`expires off`。
- 已知文件缺失时，**access门禁完成之后**的static404通过`error_page 404 = @ark_beta_cluster_code`进入受保护named fallback。没有`try_files`/rewrite改URI、版本query选择器、无凭据命中或proxy cache。
- 未列出的`/js/`、`/css/`通过受保护prefix location到同一个固定协调器；不允许filesystem wildcard读取，也不继承旧单体/正式上游。
- 三个proxy位置的唯一目标为`http://10.253.78.2:35300`，保留原URI/query。必须先证明这个协调器与当前TREE build一致；stock版本标识与root runtime build是不同字段，不能凭同端口假定内容匹配。
- proxy覆盖真实IP/转发头，清除未可信Forwarded/CF/Upgrade，隐藏上游CORS/cache/安全头，避免重复或错误策略透传。

Nginx在location增加`add_header`会取消server头继承，因此每个精确alias/prefix/named fallback都重复**stock Beta的七个原始安全表达式**：

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options $ark_beta_frame always;
add_header Referrer-Policy same-origin always;
add_header Cache-Control "private, no-store" always;
add_header Content-Security-Policy $ark_beta_csp always;
add_header X-Robots-Tag "noindex, nofollow" always;
```

唯一附加诊断是`X-Ark-Code-Source: edge|cluster`。**业务代码不加ACAO，不使用公开素材CORS***。`$ark_beta_csp`保留原表达式：stock默认依赖`$upstream_http_content_security_policy`，本地alias没有upstream时可能为空，Nginx不会输出空CSP头；工具不偷偷发明一个新CSP。若vhost想让业务CSP非空，须由主助手在同版本vhost中明确核验map值，不把表达式存在说成实际头一定存在。

include不能和旧同URL exactalias/prefix一起重复加载。安装前主助手核对原vhost，只替换Beta配套私有码include/default受保护HTTP上游，`nginx -t`后正常reload。正式vhost/game/auth、公共素材规则、PRTS动画、旧WG/recovery均不由此工具变更。

## 本批实证

2026-10-07冻结TREE build`f739f1070c66fc15bdc9e853271482827197ffbd`，完整source manifest SHA`f739f1070c66fc15bdc9e853271482827197ffbdaf0b2a5e507f05eafea77e12`，239 source条目中实际**104个**JS/CSS URL（不是估计107个）。主助手的app/resource证明独立于本工具。

- `test_cluster_private_code.py`：8测试方法通过，含多组schema/输入/链接/目录/输出拒绝子用例；程序对照stockBeta模板逐个核对七个安全header表达式。
- `test_cluster_private_code_http.py`：既有已验证Nginx1.28.3、owned loopback临时fixture，**11实际HTTP场景通过**：local body/SHA/MIME、安全头单值/private-no-store/no-CORS、HEAD、授权304、匿名GET/HEAD即使带ETag仍401、POST405、异源403、未知URI/query只去cluster、缺已知文件只去cluster、匿名缺文件不触发backend取代码、fallback HEAD。这里使用明确fixture auth header，不是真实密码/CSRF/TLS验收。
- 初次HTTP smoke只指定body/proxy临时目录，Nginx编译默认fastcgi路径使`-t`失败；后来把fastcgi/scgi/uwsgi也全部置于own临时目录，重跑上述11场景通过。没有启动系统Nginx或改真实vhost。
- 冻结app的104代码已新建staging并`--verify`通过，状态仍`activated:false`；业务源码未改，旧Git严格工具未改，真实远端TLS/门禁/素材由主助手负责。

运行：

```sh
python3 -I deploy/stardust/tools/test_cluster_private_code.py
CLUSTER_PRIVATE_CODE_HTTP=1 python3 -I deploy/stardust/tools/test_cluster_private_code_http.py
```

HTTP测试默认使用此前已验证的隔离Nginx runtime；可显式提供`CLUSTER_CODE_NGINX`、`CLUSTER_CODE_LOADER`、`CLUSTER_CODE_LIBS`，这些应来自已验证材料，不执行未知下载cwd的binary/build。所有监听只127.0.0.1，PIDs/temp/server均为owned fixture，测试结束清理。
