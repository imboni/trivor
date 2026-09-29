# Development checks

Run the frontend regressions with the installed Node dependencies:

```sh
npm test
npm run build
cargo test --workspace --locked --offline
```

The Node tests cover cutout sizing, capture serialization and renderer recovery,
model appearance restoration, preferences, local meshopt decoding, load messages,
and shortcut conflicts. Rust tests cover import, metadata, cache invalidation and
self-contained GLB export. The bundled OBJ conversion test runs on Apple Silicon.

For actual browser/WebGL coverage, install Python Playwright and use an available
Chromium browser, then run:

```sh
npm run dev -- --host 127.0.0.1
python3 tests/browser-regressions.py
```

`TRIVOR_TEST_URL` overrides the server URL. `TRIVOR_CHROME` selects a Chromium
executable; macOS Google Chrome is used when installed, otherwise Playwright's
Chromium is used. The script creates a synthetic GLB, checks 2048/4096 PNG exports,
transparent colors, appearance reset and cancellation, and saves preview screenshots
to the system temporary directory. Native IPC/dialogs are mocked in this test;
Finder registration, real clipboard access and packaged WKWebView need a macOS app
smoke test before release.
