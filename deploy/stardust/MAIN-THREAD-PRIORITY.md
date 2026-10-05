# 游戏主线程启动优先级

默认策略为 **只有游戏 Node MainThread nice=-20，其他线程 nice0**。使用普通 `SCHED_OTHER`，static priority0；`SCHED_RESET_ON_FORK` 只保护随后创建的线程/子进程，不是实时 FIFO/RR，不增加 CPU 或替代代码优化。

本工具和 systemd 单元属于**游戏宿主机**，不是第四个应用容器。仓库中的模板不代表生产已经安装、启用或重启。当前线上手动 nice=-20 与未来启动默认策略分开记录；停用 watcher 不会自动恢复已经成功设置的主线程。

## 固定部署 profile（2026-10-06）

CLI只接受固定 `prod|beta|core`，不能指定任意容器、地址、端口或Worker数。配置缺省仍`prod`，旧调用兼容；systemd三个单元均明确`--profile`并要求与root配置一致，初始错配在获取锁或调度操作前拒绝，运行中reload也不能跨profile。

- `prod`：原嘉兴ark-proto namespace，6combat+1trial/7个Worker，单`127.0.0.1:3120`；以下旧默认门槛保持。
- `beta`：ark-proto-beta project/name，service ark-proto，12+2/14个Worker，精确`127.0.0.1:3220`及`10.253.77.2:3220`两项绑定，loopback健康检查。
- `core`：未来杭州正式ark-proto namespace，12+2/14，3120同样双绑定；只准备，不随Beta部署安装或启用。

绑定按精确无序集合比较，额外/重复/通配地址拒绝；各profile有固定独立锁、事件过滤、health/线程/输出门槛。Beta/core详细要求见[BETA-SOP.md](BETA-SOP.md)，Beta manager托管生命周期时不能同时启用持锁的独立priority watcher。所有profile仍只有Main=-20、其他线程0；boot hook不代表已经安装。

## 为什么不改 Node 启动命令

`nice -20 node ...` 会让启动期 Worker/V8/libuv 线程继承负 nice，而且受限容器本身不能提升到负 nice。本方案保持 Node 用户、`cap_drop: ALL`、no-new-privileges、只读文件系统、PIDs128 和无 CPU/内存硬限额；不授予容器 CAP_SYS_NICE，不改变游戏代码、6个正式/1个试战 Worker 或其他服务。

宿主机 root helper 先等待真实6+1 ready，再对唯一 Node主TID 设置 reset-on-fork，读回后才降低 nice。已有线程不修改，随后从 MainThread 创建的 Worker/辅助线程由内核重置为0。Compose 的 `init: true` 使 Docker State.Pid 指向 init；helper 根据有界子树、同 cgroup、MainThread/TGID/Node executable 和 startTicks 定位 Node，不把 init 调成-20。

## 配置与应用门槛

`main-thread-priority.example.json` 默认 nice=-20，镜像白名单初始为空；**空白名单拒绝执行**。未来发布时，从已批准的发布记录填写完整源码 revision 和不可变 image ID，必须成对匹配，例如以下是字段结构而非有效上线配置：

```json
{
  "nice": -20,
  "startup_timeout_seconds": 90,
  "approved_images": [
    { "revision": "<完整40位源码commit>", "image_id": "sha256:<完整64位image ID>" }
  ]
}
```

可同时批准新版本与上一完整回滚版本，最多8对。配置为 root 所有、普通文件、不可由 group/other 写入（建议0600），拒绝软链接和未知字段。白名单来自实际 OCI/image/release 校验，不由 mutable tag 推断。

CLI 固定本机 `/var/run/docker.sock` 和游戏容器名 `ark-proto`、Compose project/service `ark-proto/ark-proto`；不继承远端 Docker context。只查询白名单 metadata，不读取完整 env/cmdline/inspect 或秘密。还要求：

- 容器及镜像 OCI source 均为本站 fork，revision/image ID 与批准配置一致。
- 固定健康映射 `127.0.0.1:3120 → 3000`、原安全与资源基线。
- HTTP200、ok:true、maxRooms4096、combat ready/workers6、trial ready/workers1；不能仅看 health.ok。
- 原主线程 nice0 或已批准的-20，普通策略；7个 Worker，所有非主线程 nice0/普通策略。

原现场不满足门槛时拒绝修改，**不重启游戏、不修配额/权限、不自动归零其他线程**。更改 Worker 基线前须同步审查该门槛，工具不猜测新的线程数量。

## 固定提交的宿主机材料

在联网管理机用实际已验证的完整 `SOURCE_REVISION` 导出独立材料：

```sh
git archive --format=tar "$SOURCE_REVISION" \
  deploy/stardust/tools/main-thread-priority.py \
  deploy/stardust/systemd/ark-main-thread-priority.service \
  deploy/stardust/main-thread-priority.example.json \
  deploy/stardust/MAIN-THREAD-PRIORITY.md > "$HOST_BUNDLE"
sha256sum "$HOST_BUNDLE" > "$HOST_BUNDLE.sha256"
```

与配套发布清单一起传输、核对固定提交和包/文件摘要，检查归档路径与链接后在新目录解包。宿主材料不得混入游戏 `app/` 导出、公开 assets 或镜像；尤其离线 Dockerfile 会 COPY整个app，不会自动过滤宿主文件。已有 ignored runtime 准备器不包含这些文件，不能假设旧导出/旧activation自动安装了本功能。

**只上传材料阶段不安装/启用服务。** 安装及运行属于后续明确授权的发布操作。将 helper 置于新的只读版本目录 `/opt/ark-proto/main-priority/releases/<commit>/main-thread-priority.py`，root 管理 `current` 链接、`config.json` 和单元文件。代码/目录不可由非root写入，不覆盖旧版本目录。发布记录额外保留宿主工具、配置（无凭据）和单元摘要。

## 经授权安装与验证

下列命令只供未来已获许可的窗口使用，不由测试/推送自动执行：

```sh
# 先核对新的工具、批准配置、current链接与目标容器/进程身份。
python3 -B /opt/ark-proto/main-priority/current/main-thread-priority.py \
  --config /opt/ark-proto/main-priority/config.json
python3 -B /opt/ark-proto/main-priority/current/main-thread-priority.py \
  --config /opt/ark-proto/main-priority/config.json --check
# 审核并安装 systemd/ark-main-thread-priority.service 后：
systemctl daemon-reload
systemctl enable --now ark-main-thread-priority.service
```

只读 `--check` 不争用 writer锁，不改调度：已达到配置返回0，未达到返回2，无法安全核查返回1。确认 JSON 的 configured:true、main_nice:-20、reset_on_fork:true、combat_ready6/trial_ready1；同时保留真实容器/PID/startTicks。`--check` 输出安全摘要，不是公开 health endpoint。

watcher 自身 nice0，首次扫描及带时间游标的精确 Docker start 事件覆盖宿主机启动、Docker重启/游戏重建；空闲时阻塞事件流，不周期轮询健康。每次应用重新核对身份，配置在事件/重新订阅时加载。Docker断连按1–30秒退避重订阅并再次扫描，readiness等候有上限。readiness后检查遇到瞬时健康/proc失败，仅在无改动或已确认回滚后重新验证并最多重试3次，共享单次应用deadline；永久拒绝、外部修改或未确认回滚不重试。启动后不持续抢回人为修改的优先级。

同一运行锁串行化 writer；事务异常/中断只逆序恢复**本次自己修改且身份和值仍匹配**的状态。成功事务不自动回滚，第三方修改或 PID复用不覆盖。数字TID调度调用不是pidfd原子事务，逐步身份/状态检查控制竞态，不能声称绝对原子性。

## 停用与回滚

- 只停用自动应用：`systemctl disable --now ark-main-thread-priority.service`；已成功设置的Main=-20/reset标记保留，不会把当前对局清掉。
- 若用户另行批准恢复nice0，先停watcher，用已核对的root配置将nice显式设0，再单次运行同一helper；它先恢复Main nice0，再清除reset标记，其他线程不动。不要直接运行针对整进程/全部线程的renice。
- 配套游戏回滚仍按 UPDATE-SOP 执行。先确认回滚revision/image ID在白名单内，再发现新一代Node PID并重新验收；不复用旧PID，也不能恢复已经丢失的内存对局。
- 工具/权限失败不触发游戏回滚或重启；查看固定错误摘要，人工决定后续操作。

## 本地验证

```sh
python3 -B deploy/stardust/tools/test_main_thread_priority.py -v
# 仅Linux本地宿主root显式opt-in，现有Node24镜像不pull：
SP_PRIORITY_INHERITANCE=1 python3 -B deploy/stardust/tools/test_main_thread_inheritance.py -v
```

Python测试不由Node canonical清单隐式覆盖，必须单独执行。实际fixture只启动带purpose标记的localtest容器，默认非root、cap-drop ALL、源码只读；宿主控制器只调整自己fixture的精确Node TID并finally清理。

真实游戏fixture验证6+1、新建Worker、正式/试战替换、幂等、显式恢复、Docker重启和启动事件watcher的重建/退出。独立CJS人工7-worker健康fixture专门证明libuv池在boost前不存在、异步crypto触发后新线程nice0；它不是游戏战斗或生产性能验收。镜像仅提供Node24/依赖，源码挂载工作树，不冒称旧镜像revision代表新源码。原Node SignalInspector线程名称也不代表启用了Inspector；测试不使用SIGUSR1、Inspector、profile或heapdump。
