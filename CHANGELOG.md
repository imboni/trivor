# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- Native macOS app (Tauri 2) for viewing **glTF** and **GLB** models
- Library sidebar: open file, open folder, model list with format badges
- 3D viewport with orbit, zoom, fit, and reset camera
- Inspector: mesh stats, dimension bars, material list
- English and Simplified Chinese UI
- Dark, light, and system appearance
- macOS menu bar (File / View / Edit / Window)
- Finder integration: open `.gltf` / `.glb` with Trivor
- Separate `.gltf` packing to cached GLB for reliable preview

[0.0.2]: https://github.com/imboni/trivor/releases/tag/v0.0.2
[0.0.1]: https://github.com/imboni/trivor/releases/tag/v0.0.1
