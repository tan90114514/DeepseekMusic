# DS音乐播放器（DSM）源码

DS音乐播放器是一个 Windows 本地音乐播放器，使用 Electron + React + TypeScript + SQLite（sql.js）构建。

- 当前源码版本：`0.10.0`
- 目标平台：Windows 10/11 x64
- 本地播放：HTMLAudioElement
- 数据库：SQLite 文件，使用 sql.js 读写（不依赖原生编译工具链）
- 主进程负责扫描、匹配、B站 Bridge、下载、桌面歌词窗口和数据库

## 开发信息

- 原始主要开发：DeepSeek（AI 协作开发）
- 项目发起 / 维护：tan90114514
- GitHub：https://github.com/tan90114514
- 基于版本：0.9.0
- 开发时间：2026-11-13
- AI 工具：DeepSeek
- 许可证：MIT

衍生开发请保留 `DEVELOPMENT.md` 和 `NOTICE.md`，并填写其中的衍生版本开发记录。

## 开发环境

需要：

- Node.js 20 或更新版本（本机使用 Node 24）
- npm
- Windows x64（打包 NSIS / portable 需要 Windows）

安装依赖：

```bash
npm install
```

开发运行：

```bash
npm run dev
```

类型检查：

```bash
npm run typecheck
```

构建渲染层和主进程：

```bash
npm run build
```

打包：

```bash
npm run dist
```

产物在 `dist/`，包含 NSIS 安装包和 portable 免安装包。

## 目录结构

```text
src/main/       Electron 主进程、数据库、本地扫描、歌单匹配
src/main/bili/  B站收藏夹读取、WBI 请求、DASH 音频下载
src/preload/    contextBridge 安全接口
src/renderer/   React UI、主题、桌面歌词窗口
src/shared/     主进程/preload/renderer 共用类型
extension/      Manifest V3 浏览器插件
build/          应用图标
```

## 主要模块

- `src/main/index.ts`：应用生命周期、窗口、IPC、custom protocol、Bridge、歌词窗口
- `src/main/core.ts`：扫描、元数据、歌单匹配、分类
- `src/main/db.ts`：SQLite schema 和持久化
- `src/main/importers.ts`：M3U/M3U8/CSV/JSON 导入，兼容无表头单行歌单
- `src/main/bili/service.ts`：收藏夹任务、去重、下载、分类
- `src/main/libraryFiles.ts`：删除/移动音频文件、更新数据库路径和分类
- `src/renderer/src/theme.ts`：经典/日间/夜间/自定义主题
- `src/renderer/src/LyricsOverlay.tsx`：桌面歌词悬浮窗

## 数据目录

开发时默认数据目录遵循应用名；可以用环境变量指定独立测试目录：

```powershell
$env:LOCAL_MUSIC_PLAYER_USER_DATA = "D:\some-test-userdata"
```

正式版从旧版升级时保留 `%APPDATA%\LocalMusicPlayer`，全新安装使用 `%APPDATA%\DSM`。

## 测试素材

本源码包**不包含** `test-fixtures/`。该目录在本机用于放测试音频和 B站下载文件，体积较大且可能包含第三方版权内容。需要测试时请自己准备无版权或你有权使用的音频文件。

## 插件

`extension/` 是可直接在 Edge/Chrome“加载解压缩的扩展”中使用的 Manifest V3 插件。插件只向 `127.0.0.1` 发送任务和可选 Cookie，不下载音频。

## 已知限制

- 不提供 MP3 转码。
- B站多 P 视频只处理第 1 P。
- 歌词只读取本地 LRC，不联网搜索。
- B站接口或 WBI 签名规则可能变化，相关代码在 `src/main/bili/`。
- 安装包未做代码签名。
- 移动歌曲仅支持当前音乐文件夹内；删除歌曲不会自动删除 LRC。
- 批量删除/移动逻辑在 `src/main/libraryFiles.ts`，只接受数据库中的歌曲路径，避免任意路径删除。

## 版权说明

本项目仅用于个人本地音乐管理和学习。使用者应自行确保导入、下载和播放的内容合法，并遵守相关平台条款。下载内容的版权归原作者和平台所有。


