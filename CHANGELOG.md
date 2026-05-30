# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
