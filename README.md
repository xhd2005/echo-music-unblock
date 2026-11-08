# 灰歌解灰与多源换源 (`echo-music-unblock`)

为 **EchoMusic (`>= 2.3.2`)** 打造的**全链路灰歌自动解灰、无损提质、手动换源与双语歌词兜底插件**。

当酷狗曲库中遇到无版权灰歌、下架歌曲、地区限制或仅提供试听片段时，插件会自动在后台按优先级从**本地曲库 / 酷狗同曲异版 / 多平台外部聚合源**无缝解析可用音源，并支持在底栏一键查看音源状态或手动切换音源版本。

---

## ✨ 核心特性

- **三通道全自动音源解灰（`ctx.player.audioSource.register`）**
  - **通道 1：本地授权目录匹配（`local`）**：自动复用 `echo-music-download` 已授权下载目录及自定义本地音乐文件夹，按歌名 + 歌手匹配本地 `.flac` / `.mp3` / `.m4a` / `.wav` / `.ogg`，零流量秒播。
  - **通道 2：酷狗同曲异版智能换源（`kugou-alt`）**：调用 `ctx.kugou.search.search` 检索同曲名与歌手的其它可播版本（智能过滤 DJ、伴奏、串烧等不相关版本，除非原曲本身即为对应版本）。
  - **通道 3：多平台外部音源兜底（`external`）**：支持 GDStudio 多平台聚合音源（网易云 / 酷我 / 咪咕）、Meting 标准接口、网易云直连解析，以及**自定义 API 模板**（支持 `{title}`、`{artist}`、`{keyword}`、`{hash}`、`{quality}` 占位符）。
- **低音质自动提质（`transform` 阶段）**
  - 当原曲仅返回 128k 低码率或试听片段时，可自动尝试从外部音源升级为 320k 高品或 FLAC 无损音源。
- **底栏音源状态胶囊 & 手动换源弹窗（`ctx.ui.playerbar.register`）**
  - 在播放器底栏实时显示当前歌曲的音源通道与音质标签；点击即可打开**手动换源中心**，一键扫描所有通道候选音源、固定某首歌的专属音源或清除固定。
- **多源双语歌词兜底（`ctx.lyrics.registerResolver`）**
  - 当酷狗缺少歌词时，自动按 **本地同名 `.lrc` ➔ 酷狗异版歌词 ➔ 网易云原词 + 中译合并双语 LRC ➔ LRCLIB 国际歌词库** 顺序兜底。
- **跨插件联动（与 `echo-music-download v2.2.0+` 协同）**
  - 暴露 `globalThis.__echoMusicUnblock` 桥接接口，让 `echo-music-download` 在下载灰歌或缺失歌词的歌曲时也能直接复用解灰音源与双语歌词。

---

## 📦 安装方式

### 方式一：通过插件市场订阅（推荐）

在 EchoMusic **插件管理 ➔ 市场源** 中添加：

```text
https://raw.githubusercontent.com/xhd2005/echo-music-plugins/main/echo-plugins.json
```

### 方式二：手动安装

下载最新 Release 中的 `echo-music-unblock-1.0.0.zip`，在 EchoMusic 插件页面选择导入安装。

---

## 📄 许可证

MIT License
