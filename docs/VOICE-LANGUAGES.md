# 界面语言与干员配音

## 使用方式

- 标题、大厅、房间与游戏内的「设置」统一提供界面语言和干员配音选项；大厅不再单独放重复的「语言」按钮。
- 各处设置复用同一个组件，进入游戏前和游戏中都可切换；界面语言与配音分别保存，不互相覆盖。
- 界面语言沿用已有语言包；干员配音可选中文 `cn`、日语 `jp`、英语 `en`、韩语 `kr`，默认中文。
- 「本土语言」开关（默认关）打开后，有本土语言配音（`native`：意大利语、德文、俄文、法语、西班牙语、中文-方言）的干员改说那种配音。
- 干员调配和自选详情里可以按干员另选配音（含本土语言，只列出本服务器有的配音），优先于全局选择；改全局语言不会清掉按干员的选择。
- 界面语言和全局配音分别保存在本浏览器的 `sp.pref.lang`、`sp.pref.voiceLang`，本土语言开关与按干员的选择在 `sp.pref.settings`（`voiceNative`、`voiceOverrides`），刷新后恢复；不随房间广播，也不会改变队友设置。
- 所选语言的某个战斗槽缺档、下载失败或解码失败时，回退到同槽普通话；普通话也不可用则静音。不猜测不存在的外语路径。
- 切换只停止旧配音，不重启背景音乐或音效。原有语音优先级、间隔、单位冷却和异步 token 隔离保留。

配音语言不等同于界面语言：例如英文界面可以听日配。配音也不改变干员／皮肤身份、技能时序、RNG 或房间协议。

## 本地素材覆盖

范围是当前游戏资源中有普通话战斗语音的 195 名干员，不是全部官方干员；12 类战斗槽、每人 14 个录音编号（`data/assets.json` 的 `audio`）：

| 语种 | 清单 | 干员 | 槽位 | MP3 文件 |
|---|---|---:|---:|---:|
| 中文 | `voice` | 195 | 2340 | 2730 |
| 日语 | `voiceJp` | 195 | 2340 | 2730 |
| 英语 | `voiceEn` | 182 | 2184 | 2548 |
| 韩语 | `voiceKr` | 182 | 2184 | 2548 |
| 本土语言 | `voiceNative` | 47 | 564 | 658 |
| 合计 | — | — | — | 11214 |

没有英语和韩语配音的 13 名干员：予愿安洁莉娜、怒潮凛冬、凯尔希·思衡托、贝洛内、维伊、可露希尔、谬因、机械师、珊比、克莱门莎、塔露拉、国度、冻河。这里仅说明公开来源覆盖，不证明其他来源或官方没有这些配音。本土语言配音的语种记在 `audio.voiceNativeLangType`（中文-方言 18、俄文 10、意大利语 8、西班牙语 6、德文 3、法语 2）。

仅包含行动出发、迎敌、选中、部署、技能及战斗结算语音。未新增报到／编队／任命队长、特殊单位 canonical ID 补映射或皮肤专属配音。休整期不自动播放战斗语音。

2026-10-08 导入日／英配音时，全部 7896 文件已做完整 SHA256、ffprobe 和完整 ffmpeg 解码，失败与缺失均为零。素材保持 git-ignored，不随源码提交。

## 清单与请求路径

```js
// 每个 slot 为 URL 或 URL 数组
assets.audio.voice[charId][slot]        // 中文
assets.audio.voiceJp[charId][slot]      // 日语
assets.audio.voiceEn[charId][slot]      // 英语
assets.audio.voiceKr[charId][slot]      // 韩语
assets.audio.voiceNative[charId][slot]  // 本土语言；语种见 audio.voiceNativeLangType[charId]
// 本 fork 早期的别名，仍在清单里
assets.audio.voiceByLang.{cn|jp|en}[charId][slot]
```

`voiceByLang.cn`／`jp`／`en` 精确等于 `voice`／`voiceJp`／`voiceEn`；客户端先读各语种的树，没有时读 `voiceByLang`。清单缺少所选语种时回退中文。

文件位于 `/assets/audio/voice/{cn|jp|en|kr}/{charId}/cn_XXX.mp3`（本土语言为 `/assets/audio/voice/native/{charId}_{语种}/cn_XXX.mp3`），客户端沿用 `/media/voice/…/cn_XXX` 无扩展名别名。`cn_XXX` 是事件编号，不表示录音语言。缓存按完整语言 URL 区分，原 180 项／64 MiB PCM 预算不变。

公开对象存储实际可能返回 `application/octet-stream` 或 `binary/octet-stream`，这两种类型与 `audio/*`、未声明类型一样交给 Web Audio 校验，不因通用类型取消有效 `/media/` 响应并重复请求原 `.mp3`。HTTP 404 或明确 HTML／JSON／图片类型仍回退原地址，录音下载／真实解码失败仍按同槽中文回退；类型兼容不是跳过音频正文校验。此次修复减少的是多余请求，旧原 `.mp3` 路径本来也能解码通用二进制响应。

## 素材工具

通用工具 `tools/fetch-assets.mjs` 保留旧 `--voice-lang=cn|jp|en|kr`，另支持 `--voice-langs=cn,jp,en`（逗号列表或重复参数）。多语模式自动包含中文；清单重建／prune 保留其他实际已安装语言。日语树 `voiceJp` 总会生成，英语、韩语与本土语言树默认也生成，`--no-optional-voice` 跳过这三种。

定向工具 `tools/prepare-operator-voices.mjs` 仅支持 `cn,jp,en`，默认离线，从已有普通话战斗槽和公开页面明确声明的目录制定计划，不猜测目录。

```bash
node tools/prepare-operator-voices.mjs \
  --source-dir=/path/to/separate-voice-source \
  --coverage=/path/to/coverage.json \
  --receipt=/path/to/full-download-receipt.jsonl \
  --voice-langs=cn,jp,en \
  --report=/path/to/new-report.json
```

导入器要求完整中文先通过，验证所有录音 SHA／MP3 格式／单音频流／完整解码；拒绝路径越界、软链接逃逸及不同字节覆盖。新文件临时写入后 rename，清单写入前比较原字节，避免覆盖并发修改。明确使用 `--fetch-sources` 才联网，最大两并发、不重试，403／429 停止；`--receipt` 不能与网络下载混用。覆盖和下载回执是本地准备证据，不需提交。

## 公开来源与权利

- [PRTS Wiki](https://prts.wiki/) 的公开语音页面提供语言目录和录音事件 metadata。
- 普通话目录 `voice_cn/{charId}`、日语目录 `voice/{charId}`、英语目录 `voice_en/{charId}`；实际公开录音正文由 `https://torappu.prts.wiki/assets/audio/` 提供。
- 游戏美术、录音及角色权利属于原权利人；本仓库不提交或将这些录音重新许可为开源源码。
