<div align="center">
  <img src="public/logo.png" width="96" alt="Trivor logo" />
  <h1>Trivor</h1>
  <p><em>See every dimension.</em></p>
  <p>Native glTF / GLB viewer for macOS</p>
  <p><strong>English</strong> · <a href="README.zh-Hans.md">简体中文</a></p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
    <a href="https://github.com/imboni/trivor/releases"><img src="https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey" alt="macOS 13+" /></a>
    <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-24C8DB" alt="Tauri 2" /></a>
  </p>
  <p><sub>Parts of this codebase were developed with AI assistance and reviewed by project maintainers.</sub></p>
</div>

---

## Overview

Trivor is a lightweight, native macOS application for inspecting **glTF** and **GLB** 3D assets. It combines a Rust backend for parsing and metadata with a WebGL viewport powered by [Google model-viewer](https://github.com/google/model-viewer).

## Features

| Area | Capabilities |
|------|--------------|
| **Viewport** | Orbit, zoom, fit, reset camera; double-click to fit; cinema mode with auto-rotate |
| **Library** | Open a single file or scan a folder; search; format badges; reveal in Finder |
| **Inspector** | Vertex / triangle / mesh / material counts; bounding dimensions; material swatches |
| **Scene aids** | Optional grid floor; model center and axis guides (off by default) |
| **System integration** | Native menu bar; Finder “Open with”; configurable keyboard shortcuts |
| **Preferences** | Dark, light, or system appearance; English and Simplified Chinese UI |

## Requirements

| | |
|---|---|
| **OS** | macOS 13 Ventura or later |
| **Architecture** | Apple Silicon and Intel (universal build from releases) |
| **Formats** | `.gltf` (JSON + sidecar `.bin` / textures) and `.glb` (single file) |

> **Note:** A `.gltf` file must stay in the same folder as its `.bin` and texture files. Trivor packs separate glTF assets into a cached GLB for reliable preview when needed.

## Installation

Pre-built builds are published on [GitHub Releases](https://github.com/imboni/trivor/releases).

1. Download the latest `.dmg`.
2. Drag **Trivor** into **Applications**.
3. Open a model from Finder or from **File → Open…** inside the app.

## Usage

### Open models

- **File → Open…** (`⌘O`) — select a `.gltf` or `.glb` file.
- **File → Open Folder…** (`⌘⇧O`) — scan a directory and list all supported models.
- **Finder** — right-click a model → **Open With → Trivor** (after first launch).

### Library

- Select a model in the sidebar to load it in the viewport.
- Use the search field to filter by name.
- Hover a row for **Show in Finder** and **Remove from list**.
- **Clear list** removes all entries without deleting files on disk.

### Viewport

| Control | Action |
|---------|--------|
| Drag | Orbit |
| Scroll / pinch | Zoom |
| **Fit** (`⌘0`, `F`, or double-click) | Frame the model |
| **Reset** (`⌘R` or `R`) | Return to the initial camera |
| Dock tools | Zoom, reset, cinema mode, grid floor, center & axes |

### Cinema mode

Press **`P`** or use the dock cinema control for a chrome-minimal preview. Auto-rotate can be paused from the on-screen control. Press **`Esc`** or exit cinema to restore panels.

### Settings

Open **Settings** (`⌘,`) to change language, appearance, keyboard shortcuts, and viewer scene options. Shortcut bindings are stored locally and can be reset to defaults.

## Default keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘O` | Open file |
| `⌘⇧O` | Open folder |
| `⌘,` | Settings |
| `Esc` | Close settings |
| `⌘+` / `⌘−` | Zoom in / out |
| `⌘0` / `F` | Fit to view |
| `⌘R` / `R` | Reset camera |
| `P` | Cinema mode |
| Double-click viewport | Fit to view |

All shortcuts except double-click fit can be remapped in **Settings → Shortcuts**.

## Development

### Prerequisites

- macOS 13+
- [Rust](https://rustup.rs/) 1.77+
- [Node.js](https://nodejs.org/) 20+

### Run locally

```bash
git clone https://github.com/imboni/trivor.git
cd trivor
npm install
npm run tauri dev
```

### Build release artifacts

```bash
npm run tauri build -- --target universal-apple-darwin
```

Output:

| Artifact | Path |
|----------|------|
| `.app` | `src-tauri/target/universal-apple-darwin/release/bundle/macos/` |
| `.dmg` | `src-tauri/target/universal-apple-darwin/release/bundle/dmg/` |

Signed and notarized release steps: [docs/RELEASE.md](docs/RELEASE.md).

App icon regeneration: [docs/icon.md](docs/icon.md).

### Project layout

```text
trivor/
├── src/                 # TypeScript UI (Vite)
├── src-tauri/           # Tauri shell, menus, IPC commands
├── crates/
│   ├── core/            # Scene summary types
│   ├── loaders/         # glTF / GLB load and pack
│   └── i18n/            # UI strings (en / zh-Hans)
├── public/              # Static assets (logo)
└── docs/                # Release and contributor docs
```

## Documentation

| Document | Description |
|----------|-------------|
| [README.zh-Hans.md](README.zh-Hans.md) | Simplified Chinese readme |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guide |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |
| [docs/RELEASE.md](docs/RELEASE.md) | macOS release signing |
| [docs/icon.md](docs/icon.md) | Application icon workflow |

## Third-party software

Trivor is built on open-source components. The table below lists **direct** dependencies that materially affect runtime behavior, rendering, or distribution. Transitive dependencies are omitted.

### Application & rendering

| Software | Role in Trivor | License | Project |
|----------|----------------|---------|---------|
| [Tauri](https://tauri.app/) 2 | Native macOS shell, IPC, bundling | MIT / Apache-2.0 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) |
| [@google/model-viewer](https://modelviewer.dev/) | 3D viewport web component | Apache-2.0 | [google/model-viewer](https://github.com/google/model-viewer) |
| [Three.js](https://threejs.org/) | WebGL rendering (via model-viewer; scene grid and guides) | MIT | [mrdoob/three.js](https://github.com/mrdoob/three.js) |
| [gltf](https://crates.io/crates/gltf) (Rust) | glTF / GLB parsing, inspection, and packing | MIT / Apache-2.0 | [gltf-rs/gltf](https://github.com/gltf-rs/gltf) |

### Desktop integration & backend utilities

| Software | Role in Trivor | License | Project |
|----------|----------------|---------|---------|
| [@tauri-apps/plugin-opener](https://v2.tauri.app/plugin/opener/) | Open external URLs (updates, GitHub) | MIT / Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| [rfd](https://crates.io/crates/rfd) | Native open-file / open-folder dialogs | MIT | [PolyMeilex/rfd](https://github.com/PolyMeilex/rfd) |
| [ureq](https://crates.io/crates/ureq) | HTTP client for update checks | MIT / Apache-2.0 | [algesten/ureq](https://github.com/algesten/ureq) |
| [dark-light](https://crates.io/crates/dark-light) | System appearance detection | MIT | [rust-dark-light/dark-light](https://github.com/rust-dark-light/dark-light) |
| [window-vibrancy](https://crates.io/crates/window-vibrancy) | macOS window vibrancy | MIT | [tauri-apps/window-vibrancy](https://github.com/tauri-apps/window-vibrancy) |

### Supporting Rust libraries

| Software | Role in Trivor | License |
|----------|----------------|---------|
| [serde](https://serde.rs/) / [serde_json](https://github.com/serde-rs/json) | Config and IPC serialization | MIT / Apache-2.0 |
| [glam](https://crates.io/crates/glam) | Linear algebra for scene bounds | MIT |
| [rayon](https://crates.io/crates/rayon) | Parallel glTF processing | MIT |
| [image](https://crates.io/crates/image) | Texture decoding during load | MIT |

### UI fonts & icons

Loaded at runtime for the web UI:

| Asset | Role in Trivor | License | Source |
|-------|----------------|---------|--------|
| [Inter](https://rsms.me/inter/) | Primary UI typeface | OFL-1.1 | [rsms/inter](https://github.com/rsms/inter) |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | Monospace labels and metrics | Apache-2.0 | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) |
| [Noto Serif](https://fonts.google.com/noto/specimen/Noto+Serif) | Display typography | OFL-1.1 | [notofonts/latin-greek-cyrillic](https://github.com/notofonts/latin-greek-cyrillic) |
| [Material Symbols Outlined](https://fonts.google.com/icons) | Icon font | Apache-2.0 | [google/material-design-icons](https://github.com/google/material-design-icons) |

### Format specification

| Specification | Role in Trivor |
|---------------|----------------|
| [Khronos glTF 2.0](https://www.khronos.org/gltf/) | Supported 3D asset container format |

Full license texts for bundled components are available in their respective repositories and in [LICENSE](LICENSE) for this project’s own code.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before submitting changes.

## Security

Report security issues privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © [imboni](https://github.com/imboni) and contributors.
