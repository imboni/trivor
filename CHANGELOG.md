# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-28

### Added

- **Finder Quick Look for GLB**: an embedded preview extension with orbit, zoom and Fit, system appearance, local Draco/meshopt/Basis decoders, and bounded file/scene validation — 新增访达空格预览自包含 GLB，支持旋转、缩放、适应与离线解码；超出快速预览预算时引导使用主应用
- **Finder GLB thumbnails**: local, transparent model thumbnails with offline Draco/meshopt/KTX2 decoding, bounded requests and timeouts covering queueing, file reads and rendering — 新增访达 GLB 缩略图，支持离线压缩模型与贴图；排队、读取和渲染均受总超时与资源上限约束
- **Adaptive preview capacity**: four tiers select a 128–512 MiB file budget from memory capacity, Metal recommendations and system conditions; a capacity badge shows the selected tier — 根据内存、Metal 推荐容量和系统状态自动选择四档预览预算，文件上限为 128–512 MiB，并显示当前容量档位
- macOS bundle checks verify the app, conversion helper and both Quick Look extensions' signatures, architecture coverage, matching versions and offline resources — 打包校验覆盖主应用、转换工具、Quick Look 预览与缩略图扩展

### Fixed

- Space previews use a larger budget than background thumbnails and identify the exceeded resource and its estimated usage; a small compressed file is no longer described only as "too large" — 空格预览与后台缩略图分开预算，提高预览容量，并明确展示超限项目、预计占用及上限
- Space preview budgets adapt to physical memory and the GPU's recommended working set, with a combined geometry/texture cap and reduced capacity under thermal or memory pressure — 根据内存与 GPU 推荐工作集自动调整空格预览容量，增加几何与贴图合计预算，并在过热或内存压力下收紧；后台缩略图维持原预算
- Quick Look geometry accounting includes independently copied buffer views, preventing overlapping ranges from multiplying unbudgeted allocations — 几何预算计入 bufferView 独立拷贝，防止重叠范围放大内存占用
- Quick Look sums actual mipmap dimensions and compressed-block padding, avoiding rounded texture-limit false positives and underestimates for narrow textures; unsupported HDR/raw-Zstd KTX2 paths use the full viewer — 按完整 mipmap 尺寸与压缩块补齐规则计算纹理占用，修正边界误拒与窄纹理低估；HDR 等未覆盖的 KTX2 路径提示使用主应用
- Quick Look budgets include normalized animation output copies and expanded morph tracks, and enforce node depth regardless of traversal order — 快速预览预算补齐动画数据展开与变形轨道开销，并修复节点遍历顺序造成的深度漏检

### Compatibility and limits

- Verified on macOS 27.2 with Apple M5 / 32 GiB; minimum macOS 13.0 is unchanged. The release builds for Apple Silicon and Intel. See [validation scope](https://github.com/imboni/trivor/blob/v0.5.0/tests/README.md#hardware-adaptive-preview-budgets--2026-10-28) — 已在 macOS 27.2 / M5 / 32 GiB 实测，最低系统要求仍为 macOS 13.0，提供 Apple Silicon 与 Intel 通用构建
- Finder previews require self-contained GLB files and retain decoded-resource, complexity and timeout limits; background thumbnails keep the 64 MiB file budget. Open larger or unsupported content in the main app. See [Quick Look budgets](https://github.com/imboni/trivor/blob/v0.5.0/quick-look/README.md#scope-and-limits) — 访达预览支持自包含 GLB，保留解码资源、复杂度及超时限制；后台缩略图文件上限为 64 MiB，更大型或不支持的内容请使用主应用

## [0.4.1] - 2026-10-24

### Added

- **Progressive large-model loading**: bounded structure, geometry and detail previews for GLB/glTF, cancellable background preparation, camera-preserving replacement and offline texture decoding — 大模型分阶段概览与细化、停止转换、保留视角及离线纹理解码
- **Embedded glTF export**: File → Export glTF (Embedded)… saves supported models as one portable `.gltf` file with buffers and textures included — 新增「文件 → 导出 glTF（单文件）…」，将模型及贴图保存为可独立搬移的 `.gltf`

### Fixed

- macOS window appearance follows the system, replaces existing vibrancy instead of stacking it, and keeps modal controls above the drag region — 修复跟随系统主题、重复模糊层及弹窗顶部点击被拖动区遮挡
- Cancelled loads and stale Fit operations cannot modify a replacement model; model preparation/export and cache clearing are coordinated, and exiting reaps conversion processes — 修复取消与视角竞态、转换/导出/清缓存并发及退出后残留转换进程
- Sandboxed updates open the validated downloaded DMG for Finder installation and keep the app running; no silent overwrite or forced unmount of other installer volumes — 沙盒更新改为打开已校验的 DMG 供访达安装，避免安装失败直接退出或强制卸载其他安装盘
- Compressed inputs now pass decoded geometry, texture and instance budgets; inspector metadata no longer reads GLB geometry, and obsolete preparations are cancelled — 压缩模型纳入实际资源预算，属性读取不再加载 GLB 几何，切换模型终止旧准备任务

### Compatibility and limits

- Verified on macOS 27.0.1 / Apple Silicon; minimum macOS 13.0 is unchanged. See [validation scope](https://github.com/imboni/trivor/blob/v0.4.1/tests/README.md#macos-27-compatibility--2026-10-23) — 已在 macOS 27.0.1 / Apple Silicon 实测，最低系统要求仍为 macOS 13.0
- Large GLB/glTF files use simplified previews; large OBJ/STL and required-Draco optimization retain the documented limits. See [large-model budgets](https://github.com/imboni/trivor/blob/v0.4.1/docs/large-models.md) — 大模型采用简化预览，大型 OBJ/STL 及 Draco 优化限制见[大模型说明](https://github.com/imboni/trivor/blob/v0.4.1/docs/large-models.zh-Hans.md)

## [0.4.0] - 2026-09-30

### Added

- **Cutout export options**: choose long edge (2048 / 4096 px) and 2× supersampling before export — 抠图导出可选长边分辨率与 2× 超采样
- **Copy cutout to clipboard** (`⌘⇧C` or preview panel button) — 抠图复制到剪贴板（快捷键与预览面板按钮）
- **OBJ / STL import**: convert to cached GLB via gltfpack (OBJ) or native writer (STL) — 支持 OBJ/STL 导入预览
- **Model appearance**: original / clay / warm / cool presets, live opacity and reset in Settings → Scene — 模型整体风格预设、实时透明度与一键重置
- **Export GLB** (`⌘⇧E` or File menu): package the original asset and external resources into a self-contained GLB; appearance overrides are preview-only — 从原始资源导出完整 GLB，外观调整仅用于预览及抠图
- **Quick Look scaffold** (`quick-look/README.md`) — 访达 Quick Look 扩展工程说明
- **Meshopt decoder** bundled locally for compressed GLB / preview cache — 本地 meshopt 解码器，修复大模型预览渲染

### Changed

- Cutout export uses **offscreen high-resolution rendering** so output size no longer depends on window size — 抠图改为离屏高分辨率渲染，输出尺寸不再受窗口大小限制
- Draco / meshopt / KTX2 assets preserve compression when prepared for model-viewer, including external glTF resources — 压缩模型预览保留压缩数据，并打包外置 glTF 资源
- Mouse-wheel zoom uses consistent relative distance changes and shorter camera smoothing; the axis widget skips unchanged SVG updates and full-model traversal — 滚轮缩放幅度更稳定、跟手，坐标轴减少重复绘制及模型遍历

### Fixed

- Cutout measurement queue, tiled high-resolution rendering, viewport-matching colors, 16 px output padding, and stale preview cancellation — 修复抠图死锁、离屏色彩与尺寸、留白及取消后旧预览重新出现
- Import and preview caches now track source paths and referenced materials/textures, with atomic writes — 修复同名模型缓存冲突、侧车资源变更未失效及不完整缓存
- Compressed model metadata respects node transforms and quantized coordinates — 压缩模型尺寸统计正确处理节点变换与量化坐标
- OBJ/STL Finder associations and import guidance; reserved GLB export shortcut and simplified-preview notices — 补齐文件关联、转换提示及导出快捷键冲突检测，恢复简化预览提示
- Sandboxed external-resource access prompts are serialized per load attempt; cancelling and retrying the same model works, including paths with spaces, Chinese characters or `#` — 修复外部资源重复授权提示及取消后的重试，支持空格、中文和 `#` 文件名
- GLB export preserves compressed resources, omits invalid optional fields and writes through the native save dialog's authorized path — 修复 GLB 导出的压缩资源、可选字段及沙盒保存权限
- macOS helper signing uses sandbox inheritance; release build tools retain valid Mach-O metadata — 修复转换工具沙盒签名与 macOS 发布构建失败
- Equal opposite wheel input restores the same distance without changing FOV; rapid input and reversal at zoom limits remain responsive — 修复滚轮反向缩放不一致、视角变化及缩放边界拖延

## [0.3.0] - 2026-06-03

### Added

- **Cutout export** from the viewport dock: captures the model with a transparent background, tight alpha crop, and optional padding — 视口工具栏 **抠图导出**：透明背景、按 alpha 紧裁、可留边距
- Full-screen **preview panel** before save: drag to reposition, resize the panel, pan/zoom the image, reset view — 保存前全屏 **预览面板**：拖动、缩放面板、平移/缩放图像、重置视图
- **Native Save** dialog (`save_cutout_dialog`) writes PNG via the system file picker — 通过系统 **另存为** 对话框保存 PNG
- On-canvas **frame guide** aligned to the export crop (presentation mode, guide sync fixes) — 画布 **取景框** 与导出裁切对齐（演示模式与辅助线同步修复）

### Changed

- In-app update on macOS installs silently and relaunches the app (no manual DMG drag) — macOS 应用内更新改为静默安装并重启，无需手动拖入 Applications

### Fixed

- Cutout save crash in sandboxed release builds: read-write entitlement, binary IPC for PNG bytes, main-thread save dialog — 修复打包版保存抠图崩溃：沙盒写入权限、二进制 IPC、主线程保存对话框

## [0.1.2] - 2026-06-01

### Changed

- Smaller macOS app bundle: `latin`/`latin-ext` font subsets, woff2-only web assets, Rust release `strip` + LTO (~24 MB → ~18 MB `.app`) — 缩小安装包：字体 subset、仅 woff2、Release 链接优化
- Branded macOS DMG installer window (background, icon layout, drag hint) — macOS 安装盘品牌化背景与图标布局
- Library row actions moved into the context menu; unified fade popovers for clear-list / clear-cache confirm — 侧栏操作收入右键菜单；清空列表/清除缓存共用淡入确认层
- Large-model load failures: clearer bilingual copy, export size/triangle guidance, inspector metadata when available, dismissible error overlay — 大模型加载失败：中英文说明、导出建议、失败时属性面板、可关闭错误层
- gltfpack / viewer errors localized in the web shell (follows Settings language) — 大模型错误文案改由前端 i18n，随设置语言切换
- Unified file-size display (GB above 1 GiB) — 文件大小显示统一（≥ 1 GiB 用 GB）

### Fixed

- In-app update download: 4 h HTTP timeout (ureq default 30 s aborted slow GitHub downloads), byte-level progress (`1.2 MB / 21.7 MB`), and banner keeps version after check metadata expires — 应用内更新：4 小时超时、字节级进度、横幅版本号不再消失
- Defer startup update check until the shell has painted and loading has finished (3 s grace, no banner during model load) — 启动后延迟检查更新，界面就绪后再提示
- Dismiss explorer popovers when opening clear-list menu; shared popover fade helper — 打开清空菜单时关闭其它浮层
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

[Unreleased]: https://github.com/imboni/trivor/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/imboni/trivor/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/imboni/trivor/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/imboni/trivor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/imboni/trivor/releases/tag/v0.3.0
[0.1.0]: https://github.com/imboni/trivor/releases/tag/v0.1.0
[0.0.2]: https://github.com/imboni/trivor/releases/tag/v0.0.2
[0.0.1]: https://github.com/imboni/trivor/releases/tag/v0.0.1
