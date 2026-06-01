# Large models in Trivor

**English** · [简体中文](large-models.zh-Hans.md)

Trivor is a **single-file glTF / GLB viewer** built on `model-viewer` inside a WKWebView. That stack can inspect large assets and render many production models, but it **cannot decode an entire multi‑gigabyte, tens‑of‑millions‑of‑triangles GLB into GPU memory at full fidelity**.

This document describes what Trivor does **today**, known limits, and the **planned** direction for monolithic huge GLB files (without relying on pre-cut tile folders from other projects).

---

## Current behavior (shipped)

### Threshold

Models whose on-disk size or embedded buffer total is **≥ 200 MB** enter the **large-model preview pipeline**.

Implementation: `PREVIEW_OPTIMIZE_BYTES` in `crates/loaders/src/gltf_inspect.rs`.

### What happens when you open a large GLB

1. **Inspector metadata** — JSON header only (`inspect_scene_summary_light`); geometry buffers are not fully decoded in Rust.
2. **Viewer asset** — `gltfpack` (bundled meshoptimizer sidecar) builds a **simplified meshopt GLB** in the app cache:
   - Cache path pattern: `{app_cache}/viewer/{name}-{mtime}-preview-{ratio}.glb`
   - Simplify ratio scales with file size (e.g. **2%** triangles for files ≥ 2 GB).
   - Original file on disk is **never modified**.
3. **UI** — Loading shows *Large model — auto-optimizing preview*; after success a toast notes that a **simplified preview** is shown.

### What this is good for

- Quick inspection of shape, materials, and scale.
- Avoiding WebView OOM crashes on monolithic assets.

### What this is **not**

- **Not lossless.** Triangle count is reduced on purpose.
- **Not equivalent** to Cesium 3D Tiles or pre-split spatial tiles at full detail.

### Supporting files

| Item | Purpose |
|------|---------|
| `scripts/fetch-gltfpack.sh` | Download macOS `gltfpack` sidecars for dev / universal builds |
| `src-tauri/bin/gltfpack-*` | Bundled via Tauri `externalBin` in release builds |
| `TRIVOR_GLTFPACK` env | Override sidecar path (development / tests) |

---

## Hard limits (why “just load the 2.4 GB file” fails)

| Constraint | Typical impact |
|------------|----------------|
| WKWebView memory | Loading full geometry for ~40M+ triangles often OOMs or kills the process |
| `model-viewer` | Single `src`; one scene graph; no streaming LOD |
| Decoded GPU size | Much larger than on-disk GLB; meshopt compression does not reduce decoded size unless geometry is simplified |

**Loading the original monolithic GLB at full fidelity inside the current web viewport is not achievable** without changing the rendering architecture.

---

## Planned direction (not implemented)

Goal: user still opens **one** `.glb` path; Trivor may use **any internal strategy** so the session **eventually succeeds** and geometry is **not mesh-simplified** (`-si`).

### Proposed pipeline

```
User opens model.glb (monolithic, huge)
        │
        ▼
Detect size / triangle count (JSON header + stats)
        │
        ▼
First visit: background **lossless spatial split** → cached tileset + tile GLBs
  (no gltfpack -si; optional meshopt -cc for transport only)
        │
        ▼
Viewport: Three.js (or native) **streaming** — load/unload tiles by camera
        │
        ▼
Visible regions at full source fidelity; original file unchanged
```

### Principles

- **Transparent to the user** — same file path in the library; cache under app container.
- **No dependency on external `-tiles` folders** — splitting is performed by Trivor when needed.
- **Preview mode remains a fallback** — if splitting fails or hardware is constrained, simplified preview or clear error messaging.
- **Honest UX** — first-time prepare may take many minutes; show per-stage progress, not an immediate error state.

### Out of scope for the first implementation

- Georeferencing / globe placement (Cesium-style lon/lat) — Trivor stays a **local** viewer.
- Loading entire 40M triangles into GPU simultaneously — even with tiles, memory is **view-dependent**.

### Rough effort (historical estimate)

| Phase | Scope | Estimate |
|-------|--------|----------|
| Docs + current preview polish | This document; loading copy; gltfpack discovery | Done / ongoing |
| Lossless split + cache | Rust, spatial grid/BVH, tileset manifest | ~1–2 weeks |
| Three.js tile viewport | Multi-GLB, transforms, fit, progress | ~1–2 weeks |
| Streaming + inspector aggregation | Frustum pick, tile unload, stats | ~1 week |

---

## Related reading

- [README.md](../README.md) — user-facing note on ≥ 200 MB models
- [CHANGELOG.md](../CHANGELOG.md) — release notes
- [docs/RELEASE.md](RELEASE.md) — bundling `gltfpack` in release artifacts

## Manual verification (developers)

```bash
bash scripts/fetch-gltfpack.sh
npm run tauri dev
# Open a GLB ≥ 200 MB; first load runs gltfpack, subsequent loads use cache.
```

Cache location (macOS): `~/Library/Caches/com.imboni.trivor/viewer/` (exact path follows Tauri app cache dir).
