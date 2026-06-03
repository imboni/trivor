<div align="center">
  <img src="public/logo.png" width="96" alt="Trivor logo" />
  <h1>Trivor（极视）</h1>
  <p><em>所见即三维。</em></p>
  <p>macOS 原生 glTF / GLB 模型查看器</p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
    <a href="https://github.com/imboni/trivor/releases"><img src="https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey" alt="macOS 13+" /></a>
    <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-24C8DB" alt="Tauri 2" /></a>
  </p>
  <p><sub>本项目部分代码在 AI 辅助下完成，并由维护者审查后合入。</sub></p>
</div>

---

## 概述

Trivor（极视）是一款轻量的 macOS 原生 **glTF / GLB** 模型查看器。Rust 后端负责解析与元数据提取，WebGL 视口基于 [Google model-viewer](https://github.com/google/model-viewer) 渲染。

## 功能

| 模块 | 说明 |
|------|------|
| **视口** | 旋转、缩放、适应可见区域、恢复打开时视角；双击适应；清屏预览（影院模式）与自动旋转 |
| **模型库** | 打开文件或文件夹；格式标识；在访达中显示 |
| **检查器** | 顶点 / 三角面 / 网格 / 材质数量；包围尺寸；材质色块列表 |
| **场景辅助** | 可选网格地面；模型中心与坐标轴（默认关闭） |
| **抠图导出** | 从当前视角导出透明背景 PNG；全屏预览、平移缩放后通过系统对话框保存 |
| **系统集成** | 原生菜单栏；访达「打开方式」；可自定义快捷键 |
| **偏好设置** | 深色 / 浅色 / 跟随系统；英文与简体中文界面 |

## 系统要求

| 项目 | 要求 |
|------|------|
| **操作系统** | macOS 13 Ventura 或更高版本 |
| **架构** | Apple Silicon 与 Intel（Release 提供通用二进制） |
| **格式** | `.gltf`（JSON + 外部 `.bin` / 贴图）与 `.glb`（单文件） |

> **说明：** `.gltf` 须与 sidecar 资源同目录。**≥ 200 MB** 模型会自动生成简化预览，详见 [docs/large-models.zh-Hans.md](docs/large-models.zh-Hans.md)。

## 安装

预编译包发布于 [GitHub Releases](https://github.com/imboni/trivor/releases)。

1. 下载最新 `.dmg`。
2. 将 **Trivor** 拖入「应用程序」。
3. 从访达或应用内 **文件 → 打开…** 打开模型。

> **安全提示（非 App Store 分发）：** Trivor 通过 GitHub 发布，未上架 Mac App Store。首次启动时，macOS 可能提示应用「无法验证开发者」或被安全策略拦截，属站外安装的正常情况。
>
> **允许运行（通常只需一次）：** 打开 **系统设置 → 隐私与安全性**，滚到页面底部 **安全性**，在 Trivor 相关提示旁点 **仍要打开**；或在访达中 **按住 Control 点按** **Trivor → 打开** 并确认。之后可从「应用程序」正常启动。

## 使用说明

### 打开模型

- **文件 → 打开…**（`⌘O`）— 选择 `.gltf` 或 `.glb`。
- **文件 → 打开文件夹…**（`⌘⇧O`）— 扫描目录并列出支持的模型。
- **访达** — 右键 `.gltf`、`.glb` 或文件夹 → **打开方式 → Trivor**。

### 模型库

- 在侧栏选择模型以加载到视口。
- 悬停行可 **在访达中显示** 或 **从列表移除**。
- 右键可 **刷新所在目录** 或 **刷新整个模型库**。
- **清空列表** 仅清除列表记录，不删除磁盘文件。

### 视口操作

| 操作 | 功能 |
|------|------|
| 拖拽 | 旋转 |
| 滚轮 / 捏合 | 缩放 |
| **适应**（`⌘0`、`F` 或双击） | 在**可见区域**内重新框选（扣除侧栏与底部工具栏） |
| **重置**（`⌘R` 或 `R`） | 恢复**打开模型时**的初始相机 |
| 底部工具栏 | **场景**（网格、坐标轴、抠图）· **清屏** · **相机**（适应、缩放、重置） |

macOS 使用透明 overlay 标题栏：顶部条可拖动窗口，双击可最大化/还原。修改 `tauri.conf.json` 标题栏相关配置后，需完全退出并重新运行 `npm run tauri dev`。

### 清屏预览（影院模式）

按 **`P`** 或点击工具栏清屏按钮进入极简预览。可通过屏幕控件暂停自动旋转。**`Esc`** 或退出清屏模式恢复面板。

### 设置

通过 **设置**（`⌘,`）调整语言、外观、快捷键、查看器场景选项，以及在 **存储** 中清除预览缓存。快捷键保存在本地，可一键恢复默认。

## 默认快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌘O` | 打开文件 |
| `⌘⇧O` | 打开文件夹 |
| `⌘,` | 设置 |
| `Esc` | 关闭设置 |
| `⌘+` / `⌘−` | 放大 / 缩小 |
| `⌘0` / `F` | 适应可见区域 |
| `⌘R` / `R` | 恢复打开时视角 |
| `P` | 清屏预览 |
| 双击视口 | 适应可见区域 |

除双击适应外，其余快捷键均可在 **设置 → 快捷键** 中修改。

## 开发

### 环境要求

- macOS 13+
- [Rust](https://rustup.rs/) 1.77+
- [Node.js](https://nodejs.org/) 20+

### 本地运行

```bash
git clone https://github.com/imboni/trivor.git
cd trivor
npm install
bash scripts/fetch-gltfpack.sh   # 大模型预览（macOS gltfpack 侧车）
npm run tauri dev
```

### 构建发布包

```bash
npm run tauri build -- --target universal-apple-darwin
```

产物路径：

| 产物 | 路径 |
|------|------|
| `.app` | `src-tauri/target/universal-apple-darwin/release/bundle/macos/` |
| `.dmg` | `src-tauri/target/universal-apple-darwin/release/bundle/dmg/` |

签名与公证流程见 [docs/RELEASE.md](docs/RELEASE.md)。应用图标生成见 [docs/icon.md](docs/icon.md)。

### 项目结构

```text
trivor/
├── src/                 # TypeScript 前端（Vite）；viewport-framing.ts 处理扣除面板后的适应框选
├── src-tauri/           # Tauri 壳层、菜单、IPC 命令
├── crates/
│   ├── core/            # 场景摘要类型
│   ├── loaders/         # glTF / GLB 加载与打包
│   └── i18n/            # 界面文案（en / zh-Hans）
├── assets/              # 品牌资源（应用图标源图）
├── public/              # 前端静态资源
└── docs/                # 发布与贡献文档
```

## 文档索引

| 文档 | 说明 |
|------|------|
| [README.md](README.md) | English readme |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |
| [SECURITY.md](SECURITY.md) | 安全漏洞报告 |
| [docs/RELEASE.md](docs/RELEASE.md) | macOS 发布签名 |
| [docs/large-models.zh-Hans.md](docs/large-models.zh-Hans.md) | 大模型预览与路线图 |
| [docs/icon.md](docs/icon.md) | 应用图标工作流 |

## 第三方开源软件

Trivor 基于以下开源组件构建。下表列出对**运行时行为、渲染或分发**有直接影响的**直接依赖**；传递依赖从略。

### 应用与渲染

| 软件 | 在 Trivor 中的作用 | 许可证 | 项目 |
|------|-------------------|--------|------|
| [Tauri](https://tauri.app/) 2 | macOS 原生壳层、IPC、打包 | MIT / Apache-2.0 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) |
| [@google/model-viewer](https://modelviewer.dev/) | 3D 视口 Web 组件 | Apache-2.0 | [google/model-viewer](https://github.com/google/model-viewer) |
| [Three.js](https://threejs.org/) | WebGL 渲染（经 model-viewer；场景网格与坐标辅助） | MIT | [mrdoob/three.js](https://github.com/mrdoob/three.js) |
| [gltf](https://crates.io/crates/gltf)（Rust） | glTF / GLB 解析、元数据与打包 | MIT / Apache-2.0 | [gltf-rs/gltf](https://github.com/gltf-rs/gltf) |
| [meshoptimizer / gltfpack](https://github.com/zeux/meshoptimizer) | ≥ 200 MB 模型的 meshopt 简化预览 | MIT | [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) |

### 桌面集成与后端工具

| 软件 | 在 Trivor 中的作用 | 许可证 | 项目 |
|------|-------------------|--------|------|
| [@tauri-apps/plugin-opener](https://v2.tauri.app/plugin/opener/) | 打开外部链接（更新、GitHub） | MIT / Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| [rfd](https://crates.io/crates/rfd) | 原生文件 / 文件夹对话框 | MIT | [PolyMeilex/rfd](https://github.com/PolyMeilex/rfd) |
| [ureq](https://crates.io/crates/ureq) | 更新检查 HTTP 客户端 | MIT / Apache-2.0 | [algesten/ureq](https://github.com/algesten/ureq) |
| [dark-light](https://crates.io/crates/dark-light) | 系统外观检测 | MIT | [rust-dark-light/dark-light](https://github.com/rust-dark-light/dark-light) |

### Rust 支持库

| 软件 | 在 Trivor 中的作用 | 许可证 |
|------|-------------------|--------|
| [serde](https://serde.rs/) / [serde_json](https://github.com/serde-rs/json) | 配置与 IPC 序列化 | MIT / Apache-2.0 |
| [glam](https://crates.io/crates/glam) | 场景包围盒等向量运算 | MIT |
| [rayon](https://crates.io/crates/rayon) | glTF 并行处理 | MIT |
| [image](https://crates.io/crates/image) | 加载阶段贴图解码 | MIT |

### 界面字体与图标

运行时加载的 Web UI 资源：

| 资源 | 在 Trivor 中的作用 | 许可证 | 来源 |
|------|-------------------|--------|------|
| [Inter](https://rsms.me/inter/) | 主界面字体 | OFL-1.1 | [rsms/inter](https://github.com/rsms/inter) |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | 等宽标签与数值 | Apache-2.0 | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) |
| [Noto Serif](https://fonts.google.com/noto/specimen/Noto+Serif) | 展示用衬线字体 | OFL-1.1 | [notofonts/latin-greek-cyrillic](https://github.com/notofonts/latin-greek-cyrillic) |
| [Material Symbols Outlined](https://fonts.google.com/icons) | 图标字体 | Apache-2.0 | [google/material-design-icons](https://github.com/google/material-design-icons) |

### 格式规范

| 规范 | 在 Trivor 中的作用 |
|------|-------------------|
| [Khronos glTF 2.0](https://www.khronos.org/gltf/) | 支持的 3D 资产容器格式 |

各组件完整许可证文本见其官方仓库；本项目自有代码以 [LICENSE](LICENSE) 为准。

## 参与贡献

欢迎提交 Issue 与 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 安全

安全漏洞请私下报告，详见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE) © [imboni](https://github.com/imboni) 及贡献者。
