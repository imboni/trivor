# Trivor 应用图标

macOS **会自动**给图标加圆角（squircle），**不要**在 PNG 里手动画圆角。

## 源图要求

- 推荐 **1024×1024** PNG
- 使用 `crates/ui/assets/logo-dark.png`（深色底、居中图形）
- 图形四周留 **约 12–15% 边距**（安全区），不要贴边铺满

## 生成命令

```bash
npm run icon
```

会写入 `src-tauri/icons/`（含 `icon.icns`）。修改源图后重新执行，并**完全退出**应用再打开（Dock 图标才会更新）。
