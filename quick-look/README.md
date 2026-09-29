# Trivor Quick Look Extension

Preview `.glb` files in Finder with **Space** without opening the main Trivor window.

## Status

**Scaffold only** — not yet wired into the release DMG. Track **QL-M1** in `product/plans/开发计划-2026.md`.

## Planned layout

```
quick-look/
├── README.md
└── TrivorQuickLook/          # Xcode target (to be created)
    ├── PreviewProvider.swift # QLPreviewing for .glb
    ├── Resources/            # Shared model-viewer / Three.js assets
    └── Info.plist
```

## Build integration (future)

1. Build `TrivorQuickLook.appex` in CI alongside the universal app.
2. Copy to `Trivor.app/Contents/PlugIns/TrivorQuickLook.appex`.
3. Sign app + extension together (Developer ID + notarization).
4. Document macOS **System Settings → Extensions → Quick Look** enable flow.

## Scope (M1)

- `.glb` only; orbit/zoom in WKWebView + Three.js
- No inspector, library, cutout, or format conversion

## References

- [Apple Quick Look Preview Extension](https://developer.apple.com/documentation/quicklookui/creating-a-preview-extension)
- Trivor architecture: `docs/large-models.md`, main app `src/viewer.ts`
