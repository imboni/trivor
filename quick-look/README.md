# Trivor Quick Look Extensions

Included in **Trivor 0.5.0**: preview `.glb` files in Finder with **Space** and see
rendered file thumbnails, without opening the main Trivor window. Space previews
automatically select one of four hardware capacity tiers, with a 128–512 MiB file
budget; background thumbnails retain a fixed 64 MiB file budget.

## Usage

Install the complete **Trivor 0.5.0 or later** app from
[GitHub Releases](https://github.com/imboni/trivor/releases/latest), select a self-contained
`.glb` in Finder and press **Space**. Drag to rotate, scroll to zoom, and use
**Fit**, **F**, or double-click to restore the fitted view. Space remains available
to close Quick Look. The preview follows the system appearance and language.

If macOS has disabled the extension, search System Settings for **Extensions**
and enable **Trivor GLB Preview** and **Trivor GLB Thumbnail** under Quick Look.
Other registered GLB extensions can affect which provider macOS chooses.

Finder thumbnails use a fixed three-quarter camera and transparent background.
They are rendered locally, including Draco, meshopt and KTX2 models, at up to
1024 pixels. Failed or over-budget requests return to the system's fallback icon.

## Compatibility

The minimum deployment target is **macOS 13**. Runtime testing for 0.5.0 used
**macOS 27.2 on Apple Silicon**, with SDK 27.0. Both extension architectures,
`arm64` and `x86_64`, were compiled; Intel hardware and older macOS versions were
not runtime-tested for this release. See [test results](../tests/README.md) and the
[supported content and budgets below](#scope-and-limits).

## Scope and limits

- Self-contained GLB 2.0 only; GLBs referencing external files show guidance to
  open the main app. External links and navigation are blocked.
- Same model-viewer renderer and dependency versions as Trivor, with bundled
  Draco, meshopt and KTX2/Basis decoders. Assets are loaded locally; the page's
  content security policy blocks external resources.
- Models are shown at their initial static pose. No conversion, editing, library,
  inspector or animation playback is included.
- KTX2 previews accept the bounded 2D LDR/Basis paths, including supported LDR
  GPU block-compressed formats. HDR, array/3D textures,
  and raw formats whose decompression cannot be covered by this estimate show
  guidance to use the main app.
- Space preview capacity adapts to the machine. The following are maximums for
  each tier; the GPU and current system conditions can lower the selected budget.
  Background thumbnails keep their smaller fixed budget.

  | Budget | Standard | Expanded | Large | Maximum | Thumbnail |
  |---|---:|---:|---:|---:|---:|
  | Physical memory required | Any | 16 GiB | 32 GiB | 64 GiB | Any |
  | File size | 128 MiB | 256 MiB | 384 MiB | 512 MiB | 64 MiB |
  | JSON metadata | 8 MiB | 16 MiB | 24 MiB | 32 MiB | 4 MiB |
  | Triangles, including instances | 3 million | 5 million | 8 million | 12 million | 1 million |
  | Draw calls | 1024 | 2048 | 4096 | 6144 | 512 |
  | Nodes / instances | 25,000 | 50,000 | 75,000 | 100,000 | 10,000 |
  | Estimated decoded geometry | 256 MiB | 512 MiB | 1024 MiB | 1536 MiB | 128 MiB |
  | Estimated decoded textures, including mipmaps | 256 MiB | 512 MiB | 1024 MiB | 1536 MiB | 128 MiB |
  | Geometry + textures combined | 384 MiB | 768 MiB | 1536 MiB | 2304 MiB | 256 MiB |

  The combined budget also stays within one quarter of the smallest valid Metal
  recommended working set across the machine's GPUs. If that is below the
  standard tier, the combined and individual decoded-resource caps are reduced
  further. An unavailable GPU estimate selects standard. This is an estimate of
  resource capacity, not free VRAM or a GPU speed benchmark.

  Serious/critical thermal conditions and memory-pressure warnings select
  standard for new requests, still subject to the GPU cap. Critical memory
  pressure rejects new previews and cancels previews that are still loading;
  an already rendered preview remains visible. The pressure monitor starts with
  an unknown state and listens for changes. Each request freezes one budget for
  both native and web validation; recovery does not restart cancelled work.
  The preview's capacity badge shows its selected tier, with current file and
  texture limits available in the tooltip and accessibility label.

  These are application budgets, not macOS file-size limits. A small compressed
  GLB can exceed the decoded texture budget. Images are inspected before decoding,
  and the complete mipmap chain is summed, including compressed-block padding;
  geometry estimates include buffer-view copies and normalized animation output
  expansion. Compressed geometry estimates depend on the glTF declarations.
  These estimates do not include every decoder temporary, source-data copy or
  WebKit allocation, so they are not a peak-memory guarantee. All profiles retain
  at most 4096 animation channels/samplers, 8192 tracks and
  node depth 128.
- Models over a limit show the resource, its estimated usage and the limit,
  with guidance pointing to Trivor's main app,
  which retains its progressive large-model loading. A 30-second deadline avoids
  leaving the preview indefinitely busy.

The native host reads only the selected file into a bounded immutable snapshot,
closes the file immediately, and serves that snapshot and bundled resources through
a restricted URL scheme. It uses a nonpersistent WKWebView and read-only file
access. WebKit also requires the sandbox network-client entitlement to start its
WebContent/GPU/Networking processes, even with a local custom scheme; the page's
external-resource and navigation restrictions remain enforced.
Replacement and controller teardown cancel outstanding work; stale messages cannot
finish a newer preview.

The thumbnail provider uses a separate WKWebView that is never attached to a
window. Offscreen capture renders without depending on a visible frame callback.
Only one model renders at a time; at most 64 requests are retained, each with a
15-second total deadline covering queue wait, file reads and rendering. A blocked
file read retains its slot until it returns, with at most two outstanding reads,
so timeouts cannot accumulate unbounded background work. Results that arrive
after their request has expired are discarded.

## Build and verify

Only the macOS Command Line Tools SDK and Swift compiler are required. The extension
uses `NSViewController` / `QLPreviewingController`; no separate Xcode project or
downloaded framework is needed.

```sh
npm run build:quicklook:web
TAURI_ENV_TARGET_TRIPLE=universal-apple-darwin npm run build:quicklook
npm test
npm run test:quicklook:native
npm run test:thumbnail:queue
npm run test:thumbnail:native
npm run tauri build -- --bundles app
node scripts/verify-macos-bundle.mjs target/release/bundle/macos/Trivor.app arm64
```

Use `x86_64` in the final check on an Intel Mac. A universal app build uses
`--target universal-apple-darwin` and verifies both `arm64 x86_64`.
Generated files are staged in ignored `src-tauri/.bundle/`. The macOS bundle hook
builds and signs both extensions for the selected architecture(s), using the same
identity as the main app but separate read-only entitlements. CI verifies the
embedded extensions' versions, architectures, resources and signatures.
The complete app embeds `TrivorQuickLook.appex` and `TrivorThumbnail.appex` under
`Trivor.app/Contents/PlugIns/`.

Ad-hoc local signatures are not Apple notarization. Developer ID distribution must
sign the complete app, helper and both extensions and notarize the containing package;
see [the release guide](../docs/RELEASE.md).

For local registration diagnostics, inspect the exact extension:

```sh
pluginkit -m -A -D -vv -i com.imboni.trivor.quicklook
pluginkit -m -A -D -vv -i com.imboni.trivor.thumbnail
```

Actual Finder preview testing is required in addition to compilation and signature
checks. `native/SmokeHarness/main.swift` also hosts the real controller for isolated
WebKit testing; its bundle uses the same `Resources/web` and a `SmokeFixturePath`
Info.plist entry. This harness does not prove Finder extension registration.

`npm run build:quicklook:integration` builds a native controller integration app
with camera, compressed-format, error and rapid-replacement checks. The thumbnail
native tests run with no visible window and also build a separate
`QLThumbnailGenerator` diagnostic for exercising the registered system provider.
See [test commands and results](../tests/README.md).

## References

- [Apple QuickLookUI](https://developer.apple.com/documentation/quicklookui)
- [Apple: What's New in File Management and Quick Look](https://developer.apple.com/videos/play/wwdc2019/719/)
- Trivor architecture: `docs/large-models.md`, main app `src/viewer.ts`
