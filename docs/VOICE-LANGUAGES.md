# 界面语言与干员配音

## 使用方式

- 大厅右上方的「语言」按钮统一打开界面语言和干员配音选项；标题右上角不再单独放语言开关。
- 原有标题／游戏内「设置」复用同一个组件，游戏中仍可切换。
- 界面语言沿用已有语言包；干员配音可选中文 `cn`、日语 `jp`、英语 `en`，默认中文。
- 两项分别保存在本浏览器的 `sp.pref.lang`、`sp.pref.voiceLang`，刷新后恢复；不随房间广播，也不会改变队友设置。
- 所选语言的某个战斗槽缺档、下载失败或解码失败时，回退到同槽普通话；普通话也不可用则静音。不猜测不存在的英语路径。
- 切换只停止旧配音，不重启背景音乐或音效。原有语音优先级、间隔、单位冷却和异步 token 隔离保留。

配音语言不等同于界面语言：例如英文界面可以听日配。配音也不改变干员／皮肤身份、技能时序、RNG 或房间协议。

## 2026-10-08 本地素材覆盖

范围是当前游戏资源中的 209 名干员，不是全部官方干员。沿用当前已有普通话的 191 名干员、12 类战斗槽、每人 14 个录音编号：

| 语种 | 干员 | 槽位 | MP3 文件 | 总字节 |
|---|---:|---:|---:|---:|
| 中文 | 191 | 2292 | 2674 | 68,801,427 |
| 日语 | 191 | 2292 | 2674 | 89,387,761 |
| 英语 | 182 | 2184 | 2548 | 74,124,998 |
| 合计 | — | — | 7896 | 232,314,186 |

PRTS 页面没有声明英语录音目录的 9 名干员：予愿安洁莉娜、怒潮凛冬、凯尔希·思衡托、贝洛内、维伊、可露希尔、谬因、机械师、珊比。这里仅说明本次公开来源覆盖，不证明其他来源或官方没有英配。

仅包含行动出发、迎敌、选中、部署、技能及战斗结算语音。未新增报到／编队／任命队长、特殊单位 canonical ID 补映射或皮肤专属配音。休整期不自动播放战斗语音。

全部 7896 文件已做完整 SHA256、ffprobe 和完整 ffmpeg 解码，失败与缺失均为零；原 9155 资源及旧普通话、其他音频、127 套皮肤未改。新增日／英共 5222 个文件、163,512,759 字节。素材保持 git-ignored，不随源码提交。

这只是本地准备及源码功能，不代表素材已上传或正式服已切换。线上发布仍须匹配新的游戏源码、私有码清单、静态素材与镜像，并单独获得部署授权。

## 清单与请求路径

```js
// 中文兼容入口保留
assets.audio.voice[charId][slot]
// 新字段；每个 slot 为 URL 或 URL 数组
assets.audio.voiceByLang.cn[charId][slot]
assets.audio.voiceByLang.jp[charId][slot]
assets.audio.voiceByLang.en[charId][slot]
```

`voiceByLang.cn` 精确等于旧 `audio.voice`。旧单语清单仍可使用，选择日／英时回退旧中文。

文件位于 `/assets/audio/voice/{cn|jp|en}/{charId}/cn_XXX.mp3`，客户端沿用 `/media/voice/{lang}/{charId}/cn_XXX` 无扩展名别名。`cn_XXX` 是事件编号，不表示录音语言。缓存按完整语言 URL 区分，原 180 项／64 MiB PCM 预算不变。

## 素材工具

通用工具保留旧 `--voice-lang=cn|jp|en|kr`，另支持 `--voice-langs=cn,jp,en`（逗号列表或重复参数）。多语模式自动包含中文；清单重建／prune 保留其他实际已安装语言。

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
