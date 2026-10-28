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

## Quick Look regression commands

The Quick Look tests cover GLB resource budgets, external-resource rejection,
bundle/signing configuration, native file snapshots, safe resource paths and
cancellation while delivering WebKit responses:

```sh
npm test
npm run test:quicklook:native
npm run test:thumbnail:queue
npm run build:quicklook:web
```

Serve the generated page in one terminal, then run the browser regression in a
second terminal with Python Playwright, Pillow and Chromium installed:

```sh
python3 -m http.server 1434 --bind 127.0.0.1 --directory src-tauri/.bundle/quicklook-web
python3 tests/browser-quicklook.py --output /private/tmp/trivor-quicklook-browser
python3 tests/browser-quicklook.py --model /path/model.glb --output /private/tmp/trivor-quicklook-real-model
python3 tests/browser-quicklook.py --budget-json /path/budget.json --model /path/model.glb --output /private/tmp/trivor-quicklook-adaptive
python3 tests/browser-thumbnail.py --output /private/tmp/trivor-thumbnail-browser
```

The browser test generates real Draco, meshopt and KTX2 fixtures using the installed
encoders. It checks rendered pixels, camera controls, local decoder requests,
errors, cancellation and disposal while blocking external requests. It does not
replace the actual Finder test: select a GLB, press Space, interact with the model,
close/reopen, and check compressed, malformed and over-budget fixtures.

`--budget-json` accepts one native `{tier, limits}` snapshot, records the resolved
capacity badge and tooltip, and also checks missing/invalid-budget fallback.
`node scripts/test-quicklook-native.mjs --print-runtime-budget` prints the current
machine's hardware estimate and selected snapshot; `--print-budget-profiles`
prints all tier definitions. The normal native suite verifies those definitions
against the browser validator, including the unchanged thumbnail profile.

For large local assets, stream from the exact model mapping instead of sending
the binary body through Playwright's control protocol. In two terminals, with
the same model paths in the same order:

```sh
python3 tests/browser-quicklook.py --serve-only --model /path/model.glb
python3 tests/browser-quicklook.py --stream-models --model /path/model.glb --budget-json /path/budget.json --compare-standard --output /private/tmp/trivor-quicklook-adaptive
```

The server binds only to `127.0.0.1:1434`, reads the original model in chunks and
serves the built preview page. Stop it after the test. Browser teardown has a
separate ten-second watchdog that can terminate only this test's driver; its
outcome is recorded separately from model assertions in `result.json`.

The thumbnail browser regression disables animation frames and visibility/resize
observers, then verifies transparent pixels, texture colors, request replacement,
errors and dimensions through 1024 pixels at device scale 2.

For native WebKit and the registered macOS thumbnail provider:

```sh
npm run build:quicklook:integration
npm run test:thumbnail:native
src-tauri/.bundle/TrivorThumbnailGeneratorTests.app/Contents/MacOS/TrivorThumbnailGeneratorTests /path/model.glb 512 2 /private/tmp/trivor-thumbnail-generator
```

The first command builds `TrivorQuickLookIntegration.app` in `src-tauri/.bundle/`;
launch that app to run its controller integration checks and save the report in
its container's `Library/Caches/TrivorQuickLookIntegration`. The thumbnail command
runs a sandboxed test app with no visible window, checks actual WebKit output and
renderer release, and builds the generator CLI. That CLI requires the packaged
Trivor app's extension to be registered. It explicitly rejects file-icon fallback
representations. Native runs need access to macOS WebKit/GPU services; a restricted
shell sandbox cannot substitute for the app's own sandbox test.

The queue suite is independent of WebKit and runs in Release CI. Injected reads
and renders cover blocked file reads, deadline expiry during every phase,
late/duplicate callbacks, queue capacity, reentrant completion, cross-thread
delivery and recovery after a blocked read returns.

### 0.5.0 release candidate — 2026-10-28

The version bump passed **99 Node tests, 73 Rust tests, 162 native boundary
checks**, the native/browser budget contract and **six thumbnail queue scenarios**.
The optimized 0.5.0 Apple Silicon app and DMG built successfully; the app, helper
and both extensions passed matching-version, architecture, offline-resource and
sandbox-signature checks, and the DMG checksum verified. Local DMG SHA-256:
`d55bc465ab5914ea7ad099b1239c6be4a54388081f01f21934be89ffa2a9617f`.
Runtime coverage from the feature validation is recorded below. Release CI builds
and checks the universal app separately on its macOS 15 runner.

### Hardware-adaptive preview budgets — 2026-10-28

The actual **Apple M5 / 32 GiB** Mac on **macOS 27.2 (26B123)** selected `large`
in the sandboxed native integration app. Metal reported a recommended working
set of 26,800,603,136 bytes; the selected limits were **384 MiB file, 24 MiB JSON,
1024 MiB each for geometry and textures, and 1536 MiB combined**. The initial
pressure state was explicitly `unknown`, and thermal state was `nominal`.

**99 Node tests**, **162 native checks**, the native/browser budget contract and **six queue
scenarios** passed. **18 native WKWebView integration checks with 35 preparation
callbacks** passed, including the real hardware snapshot crossing into the page,
four rendered model formats, camera controls, errors and rapid replacement.
Injected pressure changes verified cancellation during reading, boot and loading,
ready-model preservation, rejection of new requests during critical pressure,
warning downgrade and recovery only for new requests. No system memory-pressure
stress command was used. Other RAM/GPU tiers and thermal states were simulated;
these are not measurements from other physical Macs.

The windowless native thumbnail suite passed **12 checks**, including KTX2,
transparent rendering at multiple sizes, cancellation and renderer cleanup.
The real train model also passed the browser suite using the native `large`
snapshot: the capacity badge showed 384 MiB / 1024 MiB, ready took **1.89 seconds**,
and rendered pixels, orbit, zoom, Fit/F and disposal passed without external
requests or JavaScript errors. Missing and malformed snapshots both used the
standard budget. Timing is a single run, not a performance guarantee.

Texture accounting tests cover exact power-of-two, NPOT and narrow mip chains,
tiny compressed-block minimums, and real BC1/BC7/ASTC containers accepted by Three.
HDR/raw-Zstd KTX2 paths are rejected before decoding. The combined decoded limit
still rejects an overage of one byte; the mipmap correction adds no tolerance.

A second user-local model (not committed) is **135,552,008 bytes**,
with **1,274,845 triangles** and an estimated **1,073,741,808 bytes of textures**.
The same-origin streaming browser test recorded a structured file rejection in
standard (128 MiB), then successful loading in large in **2.11 seconds**, with
33,401 visible canvas pixels, orbit/zoom/Fit/F and disposal passing. The previous
rounded mip estimate exceeded the 1 GiB texture cap by eight bytes; summing its
complete mip chains puts this model 16 bytes below that unchanged cap.
Streaming avoids sending a large binary body through Playwright's control
protocol; measured loading here includes HTTP reading and model rendering.
The final registered Finder extension also opened both original model files,
showing the `large` capacity badge and 384 MiB / 1024 MiB limits. The large browser
run passed its model assertions before an old Playwright `browser.close()` hang;
its already-exited browser and remaining test driver/server were cleaned up, and
the report records the forced driver teardown. The new bounded cleanup helper
passed both normal and deliberately stalled-close checks with isolated browsers.

Both final extensions compiled for arm64 and x86_64. The Apple Silicon development
app and DMG passed nested signatures, version/architecture/resource checks, image
checksum verification and a read-only mounted app check. Final DMG SHA-256:
`196f050751dd436a0b96ef609619b2cfab46438fde8d443d407b9584bc472464`.
These local artifacts retain version 0.4.1 and are not a published release.

### Preview budget update — 2026-10-28

Space previews now use a separate, larger profile; background thumbnail budgets
are unchanged. Both native file/JSON checks and the web scene checks select their
profile explicitly. Limit errors carry a validated resource metric, observed
usage and limit, with native localized text. Geometry estimates now account for
independent buffer-view copies, including overlapping views of the same buffer.

**88 Node tests, 111 native boundary/message checks, six queue scenarios and ten
native WKWebView integration scenarios passed**. Browser preview and thumbnail
regressions passed. The native error view displayed the expected geometry value
and 256 MiB cap; malformed bridge payloads and stale callbacks remain rejected.
The integration harness stays visible only while its suite runs, avoiding a
background/occluded WebKit page waiting indefinitely for animation frames.

A user-supplied train GLB (not committed) has **7,530,204 bytes, 156,434 triangles,
nine draws and 14 WebP images**. Its decoded texture estimate is about **200 MiB**,
which explained the old 128 MiB rejection. The new preview profile passes it;
the thumbnail profile still correctly rejects it with the texture metric.
The real-browser run reached ready in **1.68 seconds** and verified actual model
pixels, orbit, zoom, Fit/F and cleanup with no outside requests or JavaScript
errors. This is one browser measurement, not a general loading-time guarantee.
The final registered extension also rendered the original train file directly
in Finder Space on macOS 27.2, including the complete body, textures and wheels.

Both extensions compiled and passed strict signatures for arm64 and x86_64.
The final Apple Silicon app/DMG passed versions, resources, architecture and
nested signatures; the DMG passed checksum verification and a read-only mounted
app check. SHA-256:
`87b7c5797ffb5e4ccfc80e9c855a72358e27fd219c249869e3ab53bcb022bc5a`.
Local artifacts remain development builds with ad-hoc signatures, not a new
published release or an Intel/older-macOS runtime test.

### Native results — 2026-10-28

On **macOS 27.2 (26B123), Apple Silicon**, **80 Node tests, 73 Rust tests and
35 native file/resource checks passed**. Browser checks passed against the
packaged preview page, including ordinary, Draco, meshopt and KTX2 GLBs, camera
controls, Fit/F, light/dark appearance, narrow layouts and rejection/recovery.

The native controller integration app passed 10 scenarios with the real
WKWebView and local scheme handler: four model formats, drag rotation, wheel
zoom, Fit/F, malformed/external/over-budget rejection and rapid replacement.
All 28 preparation callbacks completed; no JavaScript errors were reported.
The drag test supplies valid `buttons=1` pointer events within the native web
view. This exercises the production interaction path without depending on the
automation tool's incorrect `buttons=0` events observed in the October 25 run;
it is not a physical mouse hardware test.

The windowless thumbnail renderer passed 12 checks, including 64–1024 pixel
images, compressed textures, alpha/color checks, rejection, cancellation exactly
once and 12 repeated renders with no retained renderers. Every inspected renderer
WKWebView had `window == nil`; AppKit's internal text-input window stayed hidden.

Six native queue scenarios passed, covering blocked file reads and recovery,
bounded physical I/O concurrency, total deadlines, once-only callbacks,
reentrant completion, request capacity and main-thread delivery. These checks
are also included in Release CI.

Visual comparison of the actual system-provider output caught a Retina bug that
size-only assertions missed: the bitmap was scaled but the drawing rectangle was
still in points, leaving a half-size image in a corner. The provider now converts
the actual bitmap bounds to the context's user coordinates. Pixel tests check
the model's occupied area and position as well as output dimensions.

The final registered provider passed five real `QLThumbnailGenerator` requests:
cube 256px at 1×, cube 512px at 2×, meshopt 128px at 1×, Draco 384px at 1.5×,
and KTX2 1024px at 2×. Each returned a thumbnail representation, with transparent
background, colored surfaces and the expected silhouette bounds and centering.
System process/log evidence confirmed the final packaged Trivor extension ran.
After repeated local rebuilds, macOS temporarily kept choosing its SceneKit
provider despite Trivor being registered and enabled. Restarting the background
thumbnail service refreshed that selection; no Finder, screenshot permission or
global thumbnail-cache reset was involved.

Development artifacts remain ad-hoc signed. Intel compilation and the macOS 13
deployment target do not establish runtime testing on Intel or older macOS.
This run does not repeat the earlier 2 GB main-app loading benchmark.

Both extensions compiled and passed strict signatures for arm64 + x86_64. The
final Apple Silicon app and DMG passed nested signature, resources, architecture
and version checks; the DMG was checksum-verified, mounted read-only, checked
again and detached. Its SHA-256 is
`32d9c0b9ed58f16315854664eb47d31eb68217dc13edc3065984881b450ed5b4`.

### Native results — 2026-10-25

On macOS 27.0.1 / Apple Silicon, **74 Node tests and 35 native Swift checks
passed**, along with TypeScript/Vite, the release app build and strict nested
signature verification. The Apple Silicon DMG passed checksum verification and
read-only mounting; its app, helper and extension passed the same signature and
resource checks. The packaged main app opened the cube through its native picker
and reported 8 vertices, 12 triangles and dimensions 2 × 1.2 × 0.8.
The extension compiles for arm64 and x86_64 with a macOS
13 minimum target; Intel hardware and older macOS runtime behavior were not tested.

The embedded extension was registered from the built app and invoked through
Finder Space. Ordinary, meshopt, Draco and KTX2 GLBs rendered, including the KTX2
checker texture. Wheel zoom, Fit, closing/reopening and recovery after an invalid
file worked. Damaged files, external resources and excessive declared decoded
geometry displayed the intended Chinese guidance. Screenshot access required no
permission reset.

This run found and fixed two native integration failures: WebKit requires the
sandbox network-client entitlement even for local custom-scheme resources, and
Quick Look needs its preparation callback before presenting the controller. The
extension now publishes its progress view immediately and keeps a separate
30-second render deadline, avoiding a wait on an invisible renderer's first frame.

Real Chromium tests passed drag rotation, wheel zoom, Fit/F, light/dark and narrow
layouts, offline decoder loads, stale requests and disposal. Native keyboard
rotation passed in the isolated controller harness. Native automated drag could
not validate physical mouse behavior: temporary event instrumentation showed the
automation's pointerdown and pointermove both arriving with `buttons=0`, which
model-viewer correctly ignores. No workaround for this test-tool behavior was
added to production code. See the October 28 native interaction regression above
for subsequent automated coverage of the valid pointer-event path.

Temporary browser evidence and generated fixtures:
`/private/tmp/trivor-quicklook-browser`. Local builds use ad-hoc signatures and are
not notarized. These checks do not establish full-fidelity support for arbitrary
complex models; Quick Look retains the documented budgets, while large models
use the main app.

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
