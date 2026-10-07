# 显式 Formal 集群 profile

这些是本地版本化材料，不是上线、DNS、四入口就绪或容量记录。MAIN负责前端、Git、SSH安装与实际生产切换；本工具没有SSH/DNS/镜像上传功能。现有Beta TREE、75入口held状态、旧正式单体和旧WG保持，不能重跑历史controller或以新模板存在推断已接流量。

## 固定身份与隔离

所有新工具默认仍为`beta`；Formal必须显式传`--profile formal`。只允许这两个名称，不接受任意Origin/IP/subnet/port/table，也不从policy自选profile。Python API为`generate(..., profile='formal')`、`parse_policy/load_policy(..., profile='formal')`、`load_configuration(..., profile='formal')`及`prepare/verify(..., profile='formal', source_kind='commit')`。

| 项目 | Formal固定值 |
|---|---|
| Origin | `https://ark-proto.stardust.matce.cn` |
| 安装/材料 | `/opt/ark-cluster-formal/{tools,bundles}` |
| 宿主policy | `/etc/ark-cluster-formal/host-policy.json` |
| WG材料/接口/UDP | `/etc/ark-cluster-formal-wg`、`ark-wg-formal`、51839 |
| core/四edge WG | `10.253.79.2/32`、`.11/.12/.13/.14/32` |
| core/edge bridge | `172.30.245.0/24`、`172.30.246.0/24` |
| coordinator | loopback与WG35400；容器`172.30.245.2:3000` |
| private END | 仅宿主loopback35410；同core bridge游戏到coordinator3001 |
| game01..16 | loopback与WG35411..35426；容器`172.30.245.11..26:3000` |
| ingress | 仅宿主loopback35401；容器`172.30.246.2:3000` |
| project | `ark-cluster-formal-core`、`ark-cluster-formal-edge-01..04` |
| labels/guard | namespace=`formal`；`ak_cluster_formal_boot/core/edge` |

role guard优先级-20，bootstrap优先级-30；同优先级Beta规则只管自己的接口/容器IP。Formal无法选择Beta接口、端口、policy、bundle、WG目录或私有码站点，Beta亦然。profile对象不可变，不在调用中切换module全局常量。

core是MAIN现有受信SSH inventory里的杭州计算宿主，不猜测其公网/NAT端口或新建SSH配置。四个edge安装目标和编号固定如下；SSH仍用MAIN现有受信host/key，不输出凭据。

| entry | 实际嘉兴SSH目标 | WG地址 | project |
|---|---|---|---|
| 01 | `115.231.235.78` | `10.253.79.11` | `ark-cluster-formal-edge-01` |
| 02 | `115.231.235.75` | `10.253.79.12` | `ark-cluster-formal-edge-02` |
| 03 | `115.231.235.73` | `10.253.79.13` | `ark-cluster-formal-edge-03` |
| 04 | `115.231.235.92` | `10.253.79.14` | `ark-cluster-formal-edge-04` |

配置库存有四个peer和全部16路由，不代表75实际握手已通。每个入口同一全局大厅/queue，非四个独立realm。

## 固定源码、资源与镜像不能混称

`--source-kind commit`绑定完整40hex真实Git commit及独立完整64hex source manifest SHA；不会由manifest SHA截断冒称commit。`tree`仍要求build=manifestSHA[:40]且明确不是Git commit。生成器验证身份格式/关系，Git导出与全部app字节证明由MAIN完成。

MAIN的source manifest是canonical `json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')) + LF`，exact `{version:1,kind:'commit',baseRevision:<同一完整commit>,files:[按path排序的{bytes,mode,path,sha256}]}`。tree schema相同，kind为tree且baseRevision是基础commit。拒绝重复JSON key、未知字段、短/漂移摘要与不一致baseRevision。私有码工具只验证其中JS/CSS及精确库存，不宣称验证其他runtime文件或Git对象。

**Git跟踪的239代码文件与忽略的生成资源不是同一个库存。** `data/local-assets.json`等生成index必须由MAIN独立资源准备流程记录实际bytes/SHA、引用验证与完整资源digest，并绑定到实际immutable image ID；不能把忽略index冒称Git blob，不能仅因代码manifest正确或fallback HTTP200就称材质发现成功。配套资源、生成data、vendor和私有码验收另遵循[更新SOP](../../UPDATE-SOP.md)。

## MAIN独立安装合同

只向Formal的全新root目录投放；**不替换在线Beta tools、不重启Beta或旧WG**。所有工具来自同一已核对源revision/完整SHA256，root-owned、不可group/world写。`python3 -I`依赖同目录显式importlib加载；必须投放全部六个文件，不能漏共享module。

```text
/opt/ark-cluster-formal/tools/
  cluster-profile.py
  cluster-deploy.py
  cluster-host-manager.py
  cluster-wg-recover.py
  cluster-private-code.py
  main-thread-priority.py
```

父目录root-owned且不可group/world写；tools建议0755/0644。bundles父目录root-owned且无group/world写，输出目录必须不存在（空目录也不可复用）。generator产生runtime/key root:1000、目录0750/文件0440；Compose/policy0600。新policy复制到固定`/etc/ark-cluster-formal/host-policy.json`，不以symlink动态选版本。保留bundle里的真实绝对路径。

```sh
python3 -I /opt/ark-cluster-formal/tools/cluster-deploy.py \
  --profile formal --role core --out "$NEW_CORE_BUNDLE" \
  --image-id "$ACTUAL_IMAGE_ID" --source-kind commit --build "$FULL_COMMIT" \
  --manifest-sha256 "$FULL_SOURCE_MANIFEST_SHA256"

# 在对应edge宿主分别运行，编号按上表；每个入口有ALL16路由。
python3 -I /opt/ark-cluster-formal/tools/cluster-deploy.py \
  --profile formal --role edge --entry "$ENTRY_NUMBER" --out "$NEW_EDGE_BUNDLE" \
  --image-id "$ACTUAL_IMAGE_ID" --source-kind commit --build "$FULL_COMMIT" \
  --manifest-sha256 "$FULL_SOURCE_MANIFEST_SHA256"
```

镜像OCI source固定为本站fork、revision=full commit，另有source-kind/manifest标签；manager核对实际sha256:imageID、CID、project/role、source/config、RO mounts、精确bridge/发布port、PID/startTicks/StartedAt/restart/节点epoch。Docker经典引擎mount顺序只在严格验证后排序，保留全部字段；IPAM只兼容未设置IPRange省略/空字符串，真实非空range或额外语义仍拒绝。

每game8combat+2trial、control/ingress0，capacity/maxRooms0、server/off、10Hz、压缩on。容器UID1000/read-only/cap-drop ALL/no-new-privileges/PIDs128，没有CPU/memory hardcap、CAP_SYS_NICE或whole-Node nice。root host先reset-on-fork再仅Main=-20，其他线程必须nice0/SCHED_OTHER。

## Formal WG exact schema

目录`/etc/ark-cluster-formal-wg`必须root:root0700；下列metadata/key/config均root single-link0600。Beta历史无profile字段的owner/bootstrap/recovery仍有效且写出schema不改；Formal必须显式profile。

- `owner.json` exact `{profile:'formal',owner:'ark-cluster-formal-wg-20261007',local:<固定.79地址>,publicFingerprint:<sha256(ASCII WG公钥，不含LF)>}`。
- `bootstrap.json` exact owner所有字段，再加`bootstrapNftSha256`完整64hex。首次bootstrap采用`cluster-wg-recover.py`的`legacy_digest(actual_nft_JSON)`（strip handle/flags/use），只可pin本Formal closed guard。
- `private.key`是固定base64私钥加LF，不进入argv/env/输出/仓库。
- `ark-wg-formal.conf`是raw `wg setconf`格式，不是wg-quick shell配置。Interface exact `PrivateKey`、`ListenPort=51839`；没有Address/PostUp/PostDown/Table或任意脚本字段。profile通过必须一致的metadata、文件名、固定监听端口与peer库存绑定，不向setconf塞入它不支持的Profile字段。
- core四Peer按`.11/.12/.13/.14`顺序，exact `PublicKey`、`AllowedIPs=<peer>/32`、`Endpoint=<.78/.75/.73/.92>:51839`、`PersistentKeepalive=25`。edge只有一个`.2/32`Peer，exact PublicKey+AllowedIPs，**没有Endpoint/keepalive**；core主动连接并暖机，不能猜其目的地特定NAT端口。
- recovery自身生成`recovery.json`，Formal exact包含profile/version/owner/local/config_sha256/public_fingerprint/boot_id/bootstrap_sha256/phase，handed_off另有manager_project。不得手工伪造、预填或跨profile复制状态。

bootstrap由`bootstrap_text(config)`生成：strict create新table、两chain priority-30、精确peer/local ICMP accept与五个DROP。其他接口/地址无权限；Formal首次收养也验证完整六rule scopes。内核singleton peer set→scalar仅做等价归一化，不放宽IP。精确CAS/handoff只删除五个已验证DROP handles，保留ICMP/table，不flush任何表。

## 启动与检查顺序

MAIN先核对新材料及旧组件不变，再投放三个新unit到`/etc/systemd/system/`：来源为本目录上级`ark-cluster-formal-{wg,core,edge}.service`；core宿主装core，edge宿主装edge，全部装wg。独立service name/path，不改旧unit/drop-in。不要restart已有WG recovery：Requires可传播停止。

新WG oneshot先closed bootstrap→interface/address/精确routes；role root service严格`guard → WG handoff → serve`。serve再次closed、启动/健康/线程/代次验证后才开放租约；共享drift只关闭本profile，单节点错误只撤自己的精确lease。WG服务无ExecStop/down/re-key。停止manager保留容器/Main优先级；显式stop必须用记录immutable CID及完整代次，不能按名字盲停。

```sh
# 自己的Formal WG初次准备/检查（不能用于已消费controller重放）。
python3 -I /opt/ark-cluster-formal/tools/cluster-wg-recover.py --profile formal --action start
python3 -I /opt/ark-cluster-formal/tools/cluster-host-manager.py \
  --profile formal --config /etc/ark-cluster-formal/host-policy.json --action guard
python3 -I /opt/ark-cluster-formal/tools/cluster-wg-recover.py --profile formal --action handoff
# 正式常驻采用role systemd模板，不与手动serve并行争writer lock。
python3 -I /opt/ark-cluster-formal/tools/cluster-host-manager.py \
  --profile formal --config /etc/ark-cluster-formal/host-policy.json --action check
python3 -I /opt/ark-cluster-formal/tools/cluster-wg-recover.py --profile formal --action check
```

新增unit/本地测试通过不等于公开激活。TLS/门禁/Cookie独立性、生成data/资源、受保护HTTP、ALL16routes、真实浏览器与DNS就绪由MAIN分别验收；一个内存coordinator无HA/状态迁移，不做负载或容量推论。

## Formal/Beta commit私有码

`cluster-private-code.py`两profile均接受显式`--source-kind commit`；默认仍Beta tree语义。Formal输出`localcode/cluster-formal-<build>/...`、`nginx/cluster-private-code-formal.conf`；站点alias是Formal SITE，stock `$ark_proto_frame/$ark_proto_csp`，fallback `@ark_formal_cluster_code`，唯一proxy `http://10.253.79.2:35400`。Beta保留原`cluster-`prefix、SITE/maps/fallback/35300。

```sh
python3 -I /opt/ark-cluster-formal/tools/cluster-private-code.py \
  --profile formal --source-kind commit --source "$FIXED_APP" \
  --manifest "$SOURCE_MANIFEST" --manifest-sha256 "$FULL_SOURCE_MANIFEST_SHA256" \
  --build "$FULL_COMMIT" --out "$NEW_PRIVATE_STAGE"
python3 -I /opt/ark-cluster-formal/tools/cluster-private-code.py \
  --profile formal --source-kind commit --verify "$NEW_PRIVATE_STAGE" \
  --manifest "$SOURCE_MANIFEST" --manifest-sha256 "$FULL_SOURCE_MANIFEST_SHA256" --build "$FULL_COMMIT"
```

每个alias、未知prefix和缺文件fallback仍auth_request/GET|HEAD/private-no-store/no business ACAO，所有stock安全表达式重复但不发明CSP。vhost须保持Origin与/localcode封锁，不重复加载旧exactlocation。输出仅staged/activated:false；MAIN做同版本Nginx语法、平滑reload及配套切换。

## 本地检查入口

```sh
python3 -I deploy/stardust/tools/test_cluster_formal.py
python3 -I deploy/stardust/tools/test_cluster_deploy.py
python3 -I deploy/stardust/tools/test_cluster_wg_recover.py
python3 -I deploy/stardust/tools/test_cluster_private_code.py
CLUSTER_PRIVATE_CODE_HTTP=1 python3 -I deploy/stardust/tools/test_cluster_private_code_http.py
CLUSTER_NATIVE_PRIORITY=1 python3 -I deploy/stardust/tools/test_cluster_native_priority.py
unshare --net python3 -I deploy/stardust/tools/cluster-kernel-check.py --isolated-netns --profile formal
unshare --net python3 -I deploy/stardust/tools/cluster-wg-kernel-check.py --isolated-netns --profile formal --role core
unshare --net python3 -I deploy/stardust/tools/cluster-wg-kernel-check.py --isolated-netns --profile formal --role edge
```

installed-layout测试实际临时`/opt/.../tools`+`python3 -I`且不把`/`当repo；网络检查强制fresh empty netns，owned native/HTTP仅loopback/PID与临时目录。native注入Docker metadata，不冒称Compose实机验收；WG内核intrinsic不是WAN握手/整机重启；HTTP fixture不是实际TLS/密码验收。完整应用canonical由MAIN执行，不在这里重复。
