# 杭州核心与独立 Beta 验收

Beta 是独立验收环境，不是正式游戏的滚动版本、备用路由或房间迁移入口。每个域名只连接一个固定 backend。

## 最新差异（2026-10-06 14:30 +08）

正式已独立更新至7e019ee3并启用受控WS压缩，见 `releases/v013-ws-compression-20261006-7e019ee3-r2.json`。**Beta仍为1f742992/image14ad/CIDdd114e05，压缩未在Beta启用，代次与租约保留**；正式发布不自动同步Beta。旧11:42“双方相同版本”只描述当时状态。

## 历史活动状态（2026-10-06 11:42 +08）

- 正式与Beta游戏均为固定1f742992（官方上游a9dfd17），分别独立12战斗+2试算，不能把仓库文档HEAD当运行源码。
- Beta于11:28:38同步，CIDdd114e05/image14ad；配套101私有代码URL、staticv013-hangzhou-20261006-1f742992及resolver0635506/image53ac/CID1e4d5568。Beta auth仍B4（与C1同字节），独立profile/密钥不变。
- 用户明确要求跳过这次重复Beta浏览器/实战验收，记录为skip；游戏镜像/RootFS、清单、健康12+2与只读Main优先级检查完成。此前正式C1验收是参考，不冒称Beta重新实战通过。
- 两端WG恢复e6087bf现已active/exited/enabled；杭州core/Beta管理器active/enabled且Requires/After WG，11:42依赖接入未重启既有游戏或管理器。180项Python及6项隔离内核测试、现网零修改验证通过；未做实际整机重启。
- 记录 `releases/v013-beta-sync-20261006-1f742992-r2.json`，恢复操作边界见 `WG-BOOT-RECOVERY.md`。下面准备规则用于下一批，不要重跑已经完成的一次性部署脚本。

## 范围与布局

- 正式域名 `ark-proto.stardust.matce.cn` 已迁杭州core；嘉兴正式edge-only auth3141/resolver3130与OpenResty保留。后续Beta发布不得顺带重建正式游戏/认证或修改正式资源版本。
- Beta 域名 `ark-proto-beta.stardust.matce.cn` 使用嘉兴入口的独立 vhost/TLS/auth，经点对点 WG 到杭州独立 game；房间、队列、会话不与正式共享。
- `compose.beta-game.yaml` 在杭州运行 project `ark-proto-beta`、container `ark-proto-beta`，12 combat＋2 trial，映射 `127.0.0.1:3220` 和 `10.253.77.2:3220` 到3000。
- `compose.beta-edge.yaml` 在嘉兴运行同逻辑 project 的独立 auth3241、resolver3230。两台主机的 Compose 网络各自独立。
- `compose.core-game.yaml` 是杭州正式game，project/container为`ark-proto`、12＋2、3120双绑定；不得在嘉兴执行，Beta准备/更新不自动操作它。
- 三个固定game profile：旧嘉兴 `prod` 的6＋1/单loopback3120只作已停用回退；Beta `beta` 为12＋2/3220；杭州正式 `core` 为12＋2/3120。profile不是任意selector，不能改成其他容器、端口或地址。

## 准备固定候选

1. 在 feature 分支保留工作树与归档stash，完成代码和本地验证，取得本批commit/push许可后固定完整commit C。
2. 从 C 导出新目录，逐blob校验，拒绝链接、路径穿越、设备；依赖/vendor/art复用仍须验证lock、manifest与字节。
3. game runtime、auth、resolver、private localcode、host-tools分别记录摘要。宿主调度/防火墙程序、systemd、实际配置、测试证据不放进game `app/`或公开资源。
4. 以现有固定Node24基础镜像digest离线构建，无pull。真实image ID、OCI source/revision必须匹配C，不能把挂工作树的测试provider称作新候选镜像。
5. 同字节不可变素材可以按严格清单复用已有宁夏/OpenI路径，需记录实际复用release和SHA；source C不意味着旧素材天然匹配，不覆盖任何已发布目录。

## 私有业务代码落盘

`tools/prepare-localcode-release.mjs` 只供给固定commit逐URL白名单的 `/js/*.js`、`/css/*.css`，不是公开static准备器或通用proxy cache。

```sh
node deploy/stardust/tools/prepare-localcode-release.mjs \
  --namespace beta --source "$APP_EXPORT" --revision "$C" --repo "$REPO" --out "$NEW_STAGE"
node deploy/stardust/tools/prepare-localcode-release.mjs \
  --verify "$NEW_STAGE" --namespace beta --revision "$C" --repo "$REPO"
```

- 输出父目录应已存在，STAGE须不存在；工具比对实际Git blob、精确库存与SHA，不激活服务。
- 落盘代码在入口 `/www/sites/ark-proto-beta.stardust.matce.cn/localcode/C/`，只由生成的精确 location 供给。
- 命中、HEAD、条件请求/Range和缺失回源都保留门禁，浏览器仍`private,no-store`；不把`?v=`当可信版本。
- named fallback必须由Beta vhost定义，继续门禁并只指向同候选Beta backend，不能掉入正式 upstream。
- HTML、shared/sim/data、`/data.js`、`/client-build`、API、WS及auth不落盘缓存。`/js/data.js`是tracked loader，与生成shim `/data.js`不同。
- hooks adapter取同候选Beta game原件；其余库/字体/美术仍按配套资源清单，不混正式hooks身份。

## 门禁与证书

- auth固定`AUTH_PROFILE=beta`；默认prod行为不变。可信Host/Origin由profile决定，不接受请求头推导或把Beta Origin改写为正式Origin。
- Beta可在嘉兴内部复用原口令salt/hash，必须另生成独立32-byte签名key，不整份复用正式secrets；文件权限和容器可读UID按既有安全基线设置。
- 秘密不进入镜像、源码、命令参数、控制器输出、日志或证据。自动验收若使用内存中的Beta授权Cookie，应明确标注，不冒称真实口令录入已测试。
- Beta使用独立证书/目录；新HTTP-01仅供challenge，现有证书和ACME账户材料不显示、不覆盖。
- `nginx/ark-proto-beta.conf` 的 `__STATIC_RELEASE__` 只有在配套字节校验后替换，不能原样安装占位配置。
- 实际入口为OpenResty容器时使用其真实 `/www` 挂载与 `nginx -t`/正常reload；不重启代理容器、正式game或auth。验收前后比较正式vhost哈希及正式容器代次。

## WG、Docker和启动顺序

WG仅路由两个peer/32，不是跨LAN路由。保留既有CNI/Tailscale/EasyTier/默认route；不修改全局FORWARD/NAT/sysctl。

仅绑定WG地址或加INPUT规则不足以隔离Docker发布：DNAT后流量进入FORWARD，其他接口也可能直达WGIP或容器IP。

1. 在容器启动前安装本profile关闭护栏，覆盖固定容器IP:3000与conntrack原目的WGIP:发布端口；新iface非业务转发仍DROP。
2. 使用独立Compose启动game；Beta `restart=no`，不能让Docker自动恢复早于护栏。
3. 核验完整CID/image/revision、namespace、安全基线、唯一网络和固定IP，再核对health12＋2与Linux14 WorkerThread。
4. 用root-owned白名单执行对应priority helper；仅Main=-20，先SCHED_OTHER/reset-on-fork，其他线程nice0，无容器CAP_SYS_NICE。
5. 只在上述条件成立后原子开放：可信WG入接口/peer源、原目的WGIP:发布端口、核准容器IP:3000全部匹配，回复只允许同连接反向。CID不是nft字段，由管理器验证后生成精确IP规则。
6. 重建/身份变化先撤旧租约、保持关闭；新身份重新核验后开放。只修改专属表/链与manifest，不整表恢复、不放开Docker网段。早期ACCEPT不覆盖后续CNI/Docker DROP，必须验证完整链路。
7. 管理器各自仅管理固定Beta/core；WG/关闭护栏先于game。`game-backend-manager.py`负责guard→compose→priority→open及约5秒lease复核；共享WG锁最多等15秒，profile生命周期锁fail-fast。托管game时不另启同profile优先级watcher，不因Beta部署操作旧prod watcher。
8. 两manager Requires/After `ark-wireguard-route.service`，恢复unit先核验并在冷启动时创建closed护栏再恢复peer/32；现网已存在完整WG则零修改保留open租约。manager停止动作会关闭自己的lease并停止批准CID；直接restart管理器会中断其游戏。WG恢复unit没有down/ExecStop，但显式停/restart它会由Requires连带停manager，因此活跃游戏期间不能这样操作。
9. 11:42安装时先启动新WG oneshot验证现网保留，再加owned依赖drop-in、daemon-reload、enable（不带--now，不restart）。该配置通过隔离冷启动和现网幂等，尚未做实际整机重启，不将enable等同重启实测。
10. 同版本升级先仅关闭Beta入口，完成新game+resolver+代码+素材就绪后才解冻。解析器清单只含公开资源元数据，应对容器Node UID可读（当前0644）；仅更换host清单文件名，容器内固定目的`/run/config/openi-assets.json`与ASSET_MANIFEST保持一致。不要把此权限规则用于auth/verifier/signing文件。

## 用户验收与发布窗口

- 真实Beta检查门禁、Origin/CSRF、跨key拒绝、WS真实IP、内部health隐藏、JS/CSS命中和同版本fallback、资源/Preact单身份。
- 主助手亲写/看图：伤害统计单图标/触屏命中、负载枚举/未知兼容、原PRTS动画及双人战斗/试算/匹配/重连。
- 负载提示仅近10秒缓存的主线程响应压力，不代表整机CPU/Worker容量；正常/busy阈值见`server/healthMetrics.js`，未就绪/缺失/过期显示未知。不新增客户端轮询或公开原health。
- 不生产压测、不清他人房间。记录实际通过、skip、失败与回滚，不因希望早晨可切换就伪称完成。
- 正式更新与迁移留UTC+8 **05:00–08:00**，具体执行需明确指令；Beta上线、提交推送或到窗口都不自动触发正式切换。
- 旧房间/对局在内存，无法跨机迁移；回滚镜像不会恢复已丢的局。切换时客户端需刷新并协调游戏、localcode与配套素材。

## 精确回退

先停止新Beta入口流量，再停Beta管理器/容器，关闭专属backend租约；只撤本次Beta文件/规则/站点或合并恢复必要段落。保留原WG、杭州正式game及嘉兴正式edge服务，不flush ruleset、删共享网络、卸载模块、覆盖别人修改或自动清旧镜像/资源。
