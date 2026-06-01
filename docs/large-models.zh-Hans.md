# Trivor 与大模型

[English](large-models.md) · **简体中文**

Trivor 是基于 WKWebView 内 `model-viewer` 的 **单文件 glTF / GLB 查看器**。它可以解析许多生产级模型，但 **无法把数 GB、数千万三角面的整包 GLB 以全精度一次性解码进 GPU**。

本文说明 **当前已实现的行为**、硬限制，以及针对 **单个超大 GLB**（不依赖外部项目预切 `-tiles` 目录）的 **后续计划**。

---

## 当前行为（已上线）

### 阈值

当模型磁盘大小或内嵌 buffer 合计 **≥ 200 MB** 时，进入 **大模型预览管线**。

代码常量：`crates/loaders/src/gltf_inspect.rs` 中的 `PREVIEW_OPTIMIZE_BYTES`。

### 打开大 GLB 时发生什么

1. **检查器元数据** — 仅读 JSON 头（`inspect_scene_summary_light`），Rust 不全量解码几何 buffer。
2. **视口资源** — 内置 `gltfpack`（meshoptimizer）在应用缓存中生成 **简化 meshopt GLB**：
   - 缓存命名：`{app_cache}/viewer/{name}-{mtime}-preview-{ratio}.glb`
   - 简化比例随体积递增（例如 **≥ 2 GB** 时约为源三角面的 **2%**）。
   - **原文件不会被修改**。
3. **界面** — 加载文案为「模型较大，正在自动优化预览」；成功后提示当前为 **简化预览**。

### 适用场景

- 快速查看外形、材质、尺度。
- 避免整包加载导致 WebView OOM / 闪退。

### 明确 **不是**

- **不是无损** — 三角面数量会被刻意减少。
- **不等同于** Cesium 3D Tiles 或外部分片目录的全精度拼装。

### 相关文件

| 路径 | 作用 |
|------|------|
| `scripts/fetch-gltfpack.sh` | 开发 / 通用包构建时下载 macOS `gltfpack` |
| `src-tauri/bin/gltfpack-*` | 发布包通过 Tauri `externalBin` 捆绑 |
| 环境变量 `TRIVOR_GLTFPACK` | 开发或测试时指定 sidecar 路径 |

---

## 硬限制（为何「直接打开 2.4 GB」不行）

| 限制 | 影响 |
|------|------|
| WKWebView 内存 | 数千万三角面全量解码常 OOM 或进程被杀 |
| `model-viewer` | 单一 `src`，无流式 LOD |
| GPU 解码后体积 | 往往远大于磁盘 GLB；不做 simplify 的 meshopt 不能解决 GPU 上限 |

在 **现有 Web 视口架构** 下，**不可能** 以全精度同时加载整包超大 GLB。

### 导出建议（当前版本）

应用在加载失败时会提示以下参考上限（代码常量见 `gltf_inspect.rs` 中 `VIEWER_*`）：

| 档位 | 文件大小 | 三角面 | 说明 |
|------|----------|--------|------|
| 较稳 | ≤ 200 MB | ≤ 500 万 | 通常可直接打开 |
| 风险 | > 1 GB | > 2000 万 | 即使自动生成简化预览也可能无法显示 |

贴图占体积大部分时，**缩小贴图分辨率** 往往比减面更有效。可在 **设置 → 存储** 清除预览缓存后重试。

---

## 后续方向（尚未实现）

目标：用户仍只打开 **一个** `.glb`；Trivor 可在背后使用 **任意内部逻辑**，使会话 **最终能成功加载**，且 **不做 mesh 简化（`-si`）**。

### 拟定管线

```
用户打开 model.glb（单体、超大）
        │
        ▼
检测体积 / 三角面数（JSON 头 + 统计）
        │
        ▼
首次：后台 **无损空间切分** → 缓存 tileset + 分块 GLB
  （禁止 gltfpack -si；传输层可选 meshopt -cc）
        │
        ▼
视口：Three.js（或原生）**流式** — 按相机加载/卸载 tile
        │
        ▼
可见区域保持源精度；原文件仍不修改
```

### 设计原则

- **对用户透明** — 模型库仍显示同一个 `.glb` 路径；缓存在应用容器内。
- **不依赖外部 `-tiles` 目录** — 需要时由 Trivor 自动切分。
- **保留预览兜底** — 切分失败或机器性能不足时，回退简化预览或明确报错。
- **诚实进度** — 首次准备可能需数分钟；分阶段进度，避免一上来即失败态。

### 首期不做

- 地理坐标 / 地球贴地（Cesium 那套 lon/lat）— Trivor 仍是 **本地** 查看器。
- 4100 万三角面 **同时** 在 GPU — 即使分块，内存仍与 **视野** 相关。

### 工作量粗估

| 阶段 | 内容 | 预估 |
|------|------|------|
| 文档 + 当前预览打磨 | 本文；加载文案；gltfpack 发现 | 已完成 / 进行中 |
| 无损切分 + 缓存 | Rust 空间切分、tileset 清单 | 约 1–2 周 |
| Three.js 分块视口 | 多 GLB、变换、适应、进度 | 约 1–2 周 |
| 流式 + 检查器聚合 | 视锥选块、卸载、统计 | 约 1 周 |

---

## 相关文档

- [README.zh-Hans.md](../README.zh-Hans.md) — 面向用户的 ≥ 200 MB 说明
- [CHANGELOG.md](../CHANGELOG.md) — 版本记录
- [docs/RELEASE.md](RELEASE.md) — 发布包捆绑 `gltfpack`

## 手动验证（开发者）

```bash
bash scripts/fetch-gltfpack.sh
npm run tauri dev
# 打开 ≥ 200 MB 的 GLB；首次会跑 gltfpack，之后走缓存。
```

缓存目录（macOS）：`~/Library/Caches/com.imboni.trivor/viewer/`（以 Tauri 应用缓存路径为准）。可在 **设置 → 存储** 中随时清除。
