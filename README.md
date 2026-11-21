# 灰歌解灰与多源换源 (`echo-music-unblock`)

为 **EchoMusic (`>= 2.3.2`)** 打造的**全链路灰歌自动解灰、无损提质、手动换源与双语歌词兜底插件**（当前版本：`v1.1.1`）。

> **v1.1.1 修复**：全面将外部聚合源（GDStudio / Meting / 网易云 / 自定义 API）请求从 `ctx.net.fetch` 迁移至主进程无 CORS 限制的 `ctx.net.request` 并加装硬超时，彻底修复部分外部源解析卡死或被 CORS 拦截的问题。

当酷狗曲库中遇到无版权灰歌、下架歌曲、地区限制或仅提供试听片段时，插件会自动在后台按优先级从**本地曲库 / 酷狗同曲异版 / 多平台外部聚合源**无缝解析可用音源，并支持通过底栏胶囊或歌曲右键菜单一键打开原生换源弹窗。

---

## ✨ 核心特性

- **三通道全自动音源解灰（`ctx.player.audioSource.register`）**
  - **通道 1：本地授权目录匹配（`local`）**：自动复用 `echo-music-download` 已授权下载目录及自定义本地音乐文件夹，按歌名 + 歌手匹配本地 `.flac` / `.mp3` / `.m4a` / `.wav` / `.ogg`，零流量秒播。
  - **通道 2：酷狗同曲异版智能换源（`kugou-alt`）**：调用 `ctx.kugou.search.search` 检索同曲名与歌手的其它可播版本（智能过滤 DJ、伴奏、串烧等不相关版本，除非原曲本身即为对应版本）。
  - **通道 3：多平台外部音源兜底（`external`）**：支持 GDStudio 多平台聚合音源（网易云 / 酷我 / QQ 音乐，可自定义平台优先级）、Meting 标准接口、网易云直连解析，以及**自定义 API 模板**（支持 `{title}`、`{artist}`、`{album}`、`{keyword}`、`{hash}`、`{quality}` 占位符，内置连通性测试与防抖保存）。
- **低音质自动提权（`transform` 阶段）**
  - 当原曲仅返回 128k 低码率或试听片段时，可自动尝试从高品音源升级为 320k 或 FLAC 无损音源。
- **原生极简管理中心 & 「已锁定音源」描述符持久化**
  - 完全对齐 EchoMusic 第一方原生极简视觉规范：顶部 `DetailPageSliverHeader`（随主题色自适应封面）+ 原生下划线 `Tabs`（**`解灰与记录`** / **`已锁定音源`** / **`本地曲库`**）+ 右侧设置 `Drawer` + `Popconfirm` 二次确认。
  - 锁定音源持久化保存完整描述符（`provider / sourcePlatform / externalId / hash / localItem`），外部直链过期后在播放时自动按需刷新；支持搜索、单曲解锁与一键「解除全部锁定」。
- **原生 `Dialog` 换源弹窗 & 精准目标曲目隔离**
  - 支持从底栏状态胶囊、页头按钮或任意歌曲右键菜单打开，严格隔离目标歌曲与当前播放歌曲；内置通道快筛（`全部 / 本地 / 酷狗异版 / 外部`）、专辑与时长差异比对，提供 **「仅本次试听」** 与 **「切换并锁定」** 双操作。
- **多源双语歌词兜底（`ctx.lyrics.registerResolver`）**
  - 当酷狗缺少歌词时，自动按 **本地同名 `.lrc` ➔ 酷狗异版歌词 ➔ 网易云原词 + 中译合并双语 LRC ➔ LRCLIB 国际歌词库** 顺序兜底，并可在设置中按需开关双语合并。
- **跨插件联动（与 `echo-music-download` 协同）**
  - 暴露 `globalThis.__echoMusicUnblock` 桥接接口供下载插件复用解灰音源与双语歌词；检测到 `globalThis.__echoMusicDownload` 时，换源弹窗支持一键 **「下载此音源」**。

---

## 📦 安装方式

### 方式一：通过插件市场订阅（推荐）

在 EchoMusic **插件管理 ➔ 市场源** 中添加：

```text
https://raw.githubusercontent.com/xhd2005/echo-music-plugins/main/echo-plugins.json
```

### 方式二：手动安装

下载最新 Release 中的 `echo-music-unblock-1.1.1.zip`，在 EchoMusic 插件页面选择导入安装。

---

## 📄 许可证

MIT License
