# Development checks

Run the frontend regressions with the installed Node dependencies:

```sh
npm test
npm run build
cargo test --workspace --locked --offline
```

The Node tests cover cutout sizing, capture serialization and renderer recovery,
model appearance restoration, preferences, local meshopt decoding, load messages,
shortcut conflicts, wheel zoom and axis-widget updates. Rust tests cover import, metadata, cache invalidation and
self-contained GLB export. The bundled OBJ conversion test runs on Apple Silicon.

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
