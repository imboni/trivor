# Development checks

Run the frontend regressions with the installed Node dependencies:

```sh
npm test
npm run build
cargo test --workspace --locked --offline
```

The Node tests cover cutout sizing, capture serialization and renderer recovery,
model appearance restoration, preferences, local meshopt decoding, load messages,
shortcut conflicts, wheel zoom and axis-widget updates. Rust tests cover import,
metadata, cache invalidation, and self-contained GLB/glTF export. The bundled OBJ
conversion test runs on Apple Silicon.

For actual browser/WebGL coverage, install Python Playwright and use an available
Chromium browser, then run:

```sh
npm run dev -- --host 127.0.0.1
python3 tests/browser-regressions.py
python3 tests/browser-wheel-regressions.py --max-settle-ms 160 --output /private/tmp/trivor-wheel.json
```

`TRIVOR_TEST_URL` overrides the server URL. `TRIVOR_CHROME` selects a Chromium
executable; macOS Google Chrome is used when installed, otherwise Playwright's
Chromium is used. The script creates a synthetic GLB, checks 2048/4096 PNG exports,
transparent colors, appearance reset and cancellation, and saves preview screenshots
to the system temporary directory. Native IPC/dialogs are mocked in this test;
Finder registration, real clipboard access and packaged WKWebView need a macOS app
smoke test before release.

## macOS 27 compatibility — 2026-10-23

Verified the development build on **macOS 27.0.1 (26A434), Apple Silicon**, built
with Command Line Tools SDK **27.0**. `vtool -show-build` reports `sdk 27.0` and
`minos 13.0`; the minimum supported OS was not raised. Full Xcode is not installed
on this machine. Intel hardware and older macOS versions were not rerun here.

- **56 Node tests and 73 Rust tests passed**, plus TypeScript/Vite, the native
  release build, `.app` bundle and strict deep code-signature verification.
- Window changes restore inherited system appearance, replace the existing
  vibrancy view on the main thread and place modal controls above the titlebar
  drag region. Native dark/light/system switching and full-screen enter/exit
  worked. Browser hit tests passed at two window sizes and both themes. A live
  change of the OS appearance preference was not part of this run.
- The native picker opened the physically allocated **2,153,277,068-byte** fixture
  with **22,429,696 triangles**. Structure, textured geometry and detail previews
  rendered. Stop retained the visible stage, reopening continued preparation,
  and clearing the cache was disabled during preparation. Wheel interaction and
  switching to a small model worked.
- Exiting during an active conversion was checked with process sampling: parent
  PID 18277 and helper PID 18360 both disappeared. The helper was active at exit,
  rather than merely absent after an already completed conversion. Process and
  operation-gate tests also cover cancellation, shutdown and cache exclusion.
- Native **4096 × 2672** PNG save succeeded with alpha 0–255 and 16 transparent
  pixels of padding on every edge. Embedded glTF export through the File menu
  saved and reopened with 8 vertices, 12 triangles and dimensions 2 × 1.2 × 0.8.
- Real-browser regressions passed for 2048/4096 PNG, appearance restoration,
  cancellation and GLB/glTF export. LOD tests used this native run's actual cache
  files and passed camera retention, old-viewer disposal, failure retention,
  stop/retry and stale-result handling. Wheel settling stayed below 160 ms
  (slowest measured case: 138.6 ms), with unchanged FOV.
- Screenshot access worked without reauthorization. Existing App Sandbox
  permissions were retained, including the helper's sandbox inheritance.

Temporary evidence: `/private/tmp/trivor-macos27-fixtures`,
`/private/tmp/trivor-macos27-processes.json` and
`/private/tmp/trivor-wheel-macos27-review.json`. Test servers were stopped.

The update flow now validates and opens the downloaded DMG for Finder
installation, leaving the current app running. Its success/failure and path/format
checks were tested; an actual installation over the user's app was not performed.
This local build is ad-hoc signed, not notarized, and has not been released.

Compatibility review references: [Apple macOS 27 release notes](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes),
[Safari 27 / WKWebView release notes](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes),
and [App Sandbox inheritance](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).

## Progressive large models — 2026-09-30

Branch: `dev/progressive-model-loading`. Final checks: **48 Node tests**, **65 Rust
tests**, TypeScript/Vite, Apple Silicon release build, `.app` bundling and strict
deep signature verification passed. The large-model changes include cancellable
metadata/dependency scans, subprocess cancellation and cleanup, decoded resource
budgets, texture limits, instance counts, structure bounds and cache invalidation.

`tests/generate-large-model-fixtures.py` writes actual referenced geometry,
including nondegenerate terrain triangles, node transforms, materials and four
textures. It does not use sparse files or unused padding to fake a large asset:

```sh
python3 tests/generate-large-model-fixtures.py large --output /private/tmp/trivor-large-fixtures
python3 tests/generate-large-model-fixtures.py browser --output /private/tmp/trivor-large-fixtures
```

The first preset uses about 2 GiB of disk. `--gltfpack` selects a different helper
for the compressed browser fixture. Existing output files are not overwritten.
The temporary benchmark runner and measurements from this session are under
`/private/tmp/trivor-large-model-tests`; detailed results are in
[the large-model guide](../docs/large-models.md).

Real model-viewer tests used backend-produced structure, 285k-face and 1.9M-face
GLBs. They passed live camera/Reset preservation, release of old model-viewers,
failure retention, same-file retry, stopping, stale progress and late-result
handling. The external decoder CDN was blocked, and KTX2 decoding was verified
using the bundled Basis WebAssembly file. Run against Vite with actual cache files:

```sh
TRIVOR_TEST_URL=http://127.0.0.1:1423 python3 tests/browser-large-models.py \
  --structure /path/to/structure.glb --preview /path/to/preview.glb --detail /path/to/detail.glb
```

Existing browser exports, opacity/clay, 2048/4096 PNG and cancellation checks
passed. Actual wheel response also passed the 160 ms settling budget, including
reversal, limits and a narrow viewport; the FOV stayed unchanged.

The first native run exposed a real sandbox issue: gltfpack's Basis encoder uses
a fixed `/tmp` path and silently emits `ERR/` textures when it cannot write there.
The final pipeline uses WebP encoding in memory, retains texture budgets, rejects
error textures explicitly, and uses new `v2-webp` cache keys. A regression runs
texture conversion from `/` with a nonexistent `TMPDIR` and checks the actual
output dimensions. Existing KTX2 inputs still benefit from the offline decoder.

The final signed sandboxed `.app` opened the **2,153,277,068-byte, 22,429,696-face**
GLB through the native picker. The structure overview appeared, stopping retained
it, reopening retried, then textured geometry and the detailed preview rendered.
Wheel interaction worked after completion. Switching to a small cube and back
opened the detailed cache directly. Native cache inspection confirmed all four
WebP images in both generated levels and no `ERR/` placeholders. Screenshot
permissions required no additional setup.

The fixture is a regular synthetic terrain workload; this validates the 2 GB
pipeline, not universal full-fidelity support for all assets. Large OBJ/STL and
required-Draco optimization retain the documented limitations.

## Embedded glTF export — 2026-09-30

On `dev/gltf-export`, 39 Node tests and 38 Rust tests passed, along with TypeScript,
Vite and the Apple Silicon release build. The packaged `.app` passed strict deep
signature verification. New coverage includes format selection, original-source
export, busy/cancel/retry behavior, resource validation before overwriting a file,
textures, animation, empty scenes and compressed virtual buffers with or without
the optional meshopt fallback marker.

The real Rust exporter produced six files under
`/private/tmp/trivor-gltf-native/generated/`: GLB, external glTF, OBJ with two
materials and a texture, STL, and meshopt glTF with/without the fallback marker.
All 13 source files retained their SHA-256 hashes. The browser regression reopened
all six outputs in model-viewer: each retained 12 triangles and dimensions
`2 × 1.2 × 0.8`; the OBJ retained both materials and its texture. Existing
2048/4096 cutout and appearance checks also passed, with no uncaught browser errors.
The temporary server was stopped after the run.

`browser-regressions.py` accepts repeated `--reopen-gltf <path>` arguments for these
box fixtures. It checks embedded resources, geometry, materials and real rendering;
the files must have been produced by the exporter rather than mocked IPC.

In the packaged native app, **File → Export glTF (Embedded)…** opened the save
panel with `cube.gltf`. Cancelling and retrying worked. Saving through the native
panel produced `/private/tmp/trivor-gltf-native/exports/native-from-glb.gltf`, which
matched the CLI export byte-for-byte and reopened with the expected geometry.
The OBJ-derived self-contained glTF also reopened natively with both materials and
the checker texture, without a dependency-folder prompt.

## Native smoke record — 2026-09-29

Platform: macOS on Apple Silicon, packaged release `.app`, App Sandbox enabled.
These results were observed in the native app during this development session;
browser tests with mocked IPC are recorded separately below. Synthetic fixtures
live in `/private/tmp/trivor-native-final` and are not checked into the repository.
The box fixtures have dimensions `2 × 1.2 × 0.8` and 12 triangles. The OBJ has
two materials (`Terracotta`, `Teal`) and one checker texture.

Completed native checks:

- Opening the STL through Finder cold-launches the app and loads the model.
- Opening the Chinese-named external glTF (`分离.gltf`), cancelling its dependency
  folder authorization, then clicking the same model again offers authorization
  again and loads successfully after the folder is selected.
- The meshopt-compressed glTF renders. The OBJ renders with both materials and
  its checker texture after dependency folder authorization.
- Exporting each of GLB, external glTF, OBJ, STL and meshopt-compressed glTF
  produces a GLB with no JSON `null` values or external resource references.
  Geometry and material counts were checked; the OBJ retains two materials and
  one image, and the compressed export retains its compression fields. All five
  exported GLBs were reopened successfully in the native app, with matching
  geometry, dimensions and material counts. Cancelling a save dialog leaves the
  loaded model usable.
- Native save dialogs save transparent 2048- and 4096-pixel PNG exports. The
  4096-pixel image copied to the system clipboard and opened through macOS Preview
  is pixel-identical to the saved PNG. Cancelling the preview and generating it
  again also succeeds. These PNG/clipboard artifacts are in
  `/private/tmp/trivor-native-test/exports`; an additional native 4096 × 2672
  export in `/private/tmp/trivor-native-final/exports` has alpha 0–255 and exactly
  16 transparent pixels of padding on all four sides.

- The final rebuilt app opens
  `/private/tmp/trivor-native-final/hash-assets/material-box.obj`. Its references
  contain `#` in both `material#box.mtl` and `materials/checker#color.png`; both
  materials and the checker texture render correctly after folder selection.
- The final app passes `codesign --verify --deep --strict`. The main app retains
  App Sandbox, user-selected read/write and network-client entitlements; the
  helper has exactly App Sandbox and sandbox inheritance. This local build is
  ad-hoc signed and has not been notarized by Apple.
- The final Apple Silicon DMG passes `hdiutil verify`. Its SHA-256 is
  `cc9c871100c167a973114bdf7d85f91010872af0e36ed419a3980c147ae466c4`.
  The final automated checks passed: 35 Node tests, 31 Rust tests, TypeScript and
  Vite production build. Intel hardware and Apple notarization were not tested.

Independent browser/WebGL regression on the same date passed with a fresh
headless Chrome instance and temporary Vite server. It covered local meshopt
decoding, appearance/opacity reset, original-source export, cancelled exports,
and transparent PBR/clay output. PNG results were `2048 × 1274` at 1× sampling
and `4096 × 2535` at 2× sampling in a smaller window, both with exactly 16 pixels
of padding on every side and identical opaque center colors. No uncaught browser
errors occurred, and the temporary server was shut down afterward.

## Wheel zoom regression — 2026-09-29

The ordinary mouse-wheel path now changes camera distance exponentially while
preserving FOV, accumulates rapid input against the pending goal, and clamps that
goal to the same bounds as the camera. Reduced interpolation decay removes the
long tail. The axis widget no longer traverses model descendants or replaces its
SVG when the displayed orientation is unchanged.

With a synthetic box in headless Chrome (SwiftShader), a trusted 100-pixel wheel
input previously changed radius by 87.8% and took about 225 ms to reach 95% of its
goal. The final run changed radius by 12.75% and reached 95% in 53.3 ms. Continuous
input settled in 76.8 ms after the last event. Equal opposite input restored the
original radius with unchanged FOV. Rapid reversal, reversal at both limits,
zero/small deltas, line/page units, same-turn bursts and a narrow viewport with
17-degree FOV all passed. Every measured convergence stayed below the test's
160 ms limit; these are browser camera timings, not native display latency.
The full report for this session is `/private/tmp/trivor-wheel-final.json`.

The rebuilt Apple Silicon release app was also opened with the exported box GLB.
Native wheel input in both directions changed model size correctly. The rebuilt
app's signature and DMG integrity checks passed. The installed copy in
`/Applications` was not replaced by this test.

For this session's native artifacts, run the read-only inspection script:

```sh
python3 /private/tmp/trivor-native-final-check.py
```

It reports GLB null/external references, geometry/material counts and compression
fields, plus PNG dimensions, alpha range and visible bounds. It lists missing
suggested exports explicitly; a partial set of files is not evidence that the
remaining native checks passed.
