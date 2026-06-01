# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Large-model load failures: clearer bilingual copy, export size/triangle guidance, inspector metadata when available, dismissible error overlay — 大模型加载失败：中英文说明、导出建议、失败时属性面板、可关闭错误层
- gltfpack / viewer errors localized in the web shell (follows Settings language) — 大模型错误文案改由前端 i18n，随设置语言切换
- Unified file-size display (GB above 1 GiB) — 文件大小显示统一（≥ 1 GiB 用 GB）

### Fixed

- Invalidate corrupt preview cache entries before re-running gltfpack — 损坏的预览缓存会先删除再重建
- Suppress raw model-viewer JavaScript errors in the UI — 不再向用户展示 model-viewer 内部 JS 报错

## [0.1.1] - 2026-06-01

### Added

- Automatic simplified preview for models ≥ 200 MB via bundled `gltfpack` (meshopt cache); original file unchanged — 超过 200 MB 的模型自动用 gltfpack 生成简化预览缓存，原文件不变
- [docs/large-models.md](docs/large-models.md) — large GLB limits, current preview behavior, and planned lossless pipeline — 大模型说明文档（现状与后续全精度方案）
- macOS overlay title bar with transparent webview; grid extends into the title bar zone — macOS 沉浸式 overlay 标题栏与透明 WebView，网格延伸至标题栏区域
- **Fit visible area** (`F`, double-click): reframes within unobstructed viewport (panels and dock) — **适应可见区域**：在扣除侧栏与底部工具栏后的区域重新框选
- Dedicated fit control in the bottom dock — 底部工具栏新增「适应」按钮
- Finder **Open With** for `.gltf` / `.glb`; folder open via Finder — 访达「打开方式」支持 glTF/GLB，文件夹可直接打开
- **Settings → Storage**: clear preview/repack cache on demand — 设置中可手动清除预览缓存

### Changed

- README installation notes for Gatekeeper / Privacy & Security when installing outside the App Store — README 补充非 App Store 安装时的 macOS 安全验证说明
- Bottom dock regrouped: scene tools (grid, axes) on the left, camera tools (fit, zoom, reset) on the right — 底部工具栏重排：场景在左、相机在右
- Fit vs reset tooltips clarified (visible area vs initial load pose) — 区分「适应可见区域」与「恢复打开时视角」
- Settings GitHub link uses the GitHub mark icon — 设置页 GitHub 链接改用 GitHub 图标

### Fixed

- Fit no longer shrinks the model on repeated clicks — 修复重复「适应」导致模型越变越小
- Preview grid no longer clipped at the sides when fitting with panels open — 修复适应视口时网格地面左右被裁切
- Load failures for large models show an advisory hint (no hard file-size cap) — 大模型加载失败时显示提示，不再硬性限制文件大小
- Large-model loading copy distinguishes “preparing” vs “auto-optimizing preview”; progress starts before pack completes — 大模型加载文案区分「准备」与「自动优化预览」，避免一上来像失败
- Universal release bundle includes merged `gltfpack` sidecar for Apple Silicon and Intel — 修复通用版安装包缺少 universal gltfpack  sidecar
- Fix panel frosted glass broken by overlay title bar change; tune blur strength — 修复 overlay 标题栏改动后面板毛玻璃失效，并增强模糊强度

## [0.1.0] - 2026-05-30

First public release for **macOS 13+** — 面向 macOS 13+ 的首个公开发行版。

**Open & library · 打开与模型库**

- Open `.gltf` / `.glb` or folders from the app or Finder — 在应用内或访达打开 `.gltf` / `.glb` 或文件夹
- Folder-based library with format badges; reveal in Finder; remove from list — 按目录管理模型库，显示格式标识，在访达中显示，从列表移除
- Right-click to refresh a folder or the whole library — 右键刷新所在目录或整个模型库

**Viewport · 视口**

- Orbit, zoom, fit, and reset; double-click to fit — 旋转、缩放、适应与重置，双击适应
- Cinema mode with auto-rotate — 清屏预览与自动旋转
- Optional grid floor; model center and axis guides — 可选网格地面、模型中心与坐标轴
- Axis orientation widget synced with the camera — 右下角轴向指示，与相机同步

**Inspector & settings · 检查器与设置**

- Mesh stats, bounding dimensions, material swatches — 网格统计、包围尺寸、材质色块
- English and 简体中文; dark, light, or system appearance — 英文与简体中文，深色 / 浅色 / 跟随系统
- Customizable keyboard shortcuts — 可自定义快捷键

**Other · 其他**

- Collapsible library and inspector panels — 可折叠模型库与检查器面板
- About dialog with update check — 关于对话框与更新检查

**Fixed · 修复**

- Icons and UI fonts load correctly in release builds — 修复发布版图标与界面字体无法加载

## [0.0.2] - 2026-05-28

### Added

- Collapsible library and inspector panels, cinema mode with auto-rotate controls
- Smoother loading progress for parse, pack, and render stages

### Fixed

- Faster model switching with async path resolution and parallel glTF packing
- Camera no longer bleeds between models when switching in the library
- Reset view (R) reliably returns to the initial load-time framing after cinema mode
- Viewport chrome offset and auto-rotate behavior in cinema mode

## [0.0.1] - 2026-05-27

### Added

- Initial Tauri 2 shell for viewing glTF and GLB models
- Library sidebar, 3D viewport, inspector, themes, and bilingual UI

[Unreleased]: https://github.com/imboni/trivor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/imboni/trivor/releases/tag/v0.1.0
[0.0.2]: https://github.com/imboni/trivor/releases/tag/v0.0.2
[0.0.1]: https://github.com/imboni/trivor/releases/tag/v0.0.1
