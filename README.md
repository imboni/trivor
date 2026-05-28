# Trivor（极视）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey)](https://github.com/imboni/trivor)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)](https://tauri.app/)

**Trivor** is a native **glTF / GLB** viewer for macOS. Built with [Tauri 2](https://tauri.app/) and [Google model-viewer](https://github.com/google/model-viewer).

- Open `.gltf` / `.glb` or browse a folder of models  
- Orbit, zoom, fit, and reset the camera  
- Inspector: meshes, dimensions, materials  
- Dark / light / system theme · English & 简体中文  
- Native menu bar and Finder file associations  

<p align="center">
  <img src="public/logo.png" width="96" alt="Trivor logo" />
</p>

## Download

Pre-built macOS builds are published on **[GitHub Releases](https://github.com/imboni/trivor/releases)** (universal binary: Apple Silicon + Intel).

> Requires **macOS 13 Ventura** or later.

## Build from source

### Prerequisites

- macOS 13+
- [Rust](https://rustup.rs/) 1.77+
- [Node.js](https://nodejs.org/) 20+

### Development

```bash
git clone https://github.com/imboni/trivor.git
cd trivor
npm install
npm run tauri dev
```

### Release binary (local)

```bash
npm run tauri build -- --target universal-apple-darwin
```

The `.app` and `.dmg` appear under `target/universal-apple-darwin/release/bundle/macos/`.

Optional signed / notarized builds: see [docs/RELEASE.md](docs/RELEASE.md).

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| ⌘O | Open file |
| ⌘⇧O | Open folder |
| ⌘, | Settings |
| ⌘+ / ⌘− | Zoom in / out |
| ⌘0 | Fit to view |
| ⌘R | Reset camera |
| Double-click viewport | Fit |
| Esc | Close settings |

## Project structure

```text
trivor/
├── src/              # Vite + TypeScript UI
├── src-tauri/        # Tauri shell, menus, commands
├── crates/
│   ├── core/         # Scene types
│   ├── loaders/      # glTF / GLB loading
│   └── i18n/         # en / zh-Hans strings
└── docs/             # Release & contributor docs
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before opening a PR.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © [imboni](https://github.com/imboni) and contributors.
