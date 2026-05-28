# Release guide (maintainers)

Trivor is distributed as **open source** via [GitHub Releases](https://github.com/imboni/trivor/releases). This document is for maintainers building signed binaries locally.

## Tag a release

1. Bump `version` in `package.json`, `Cargo.toml` (workspace), and `src-tauri/tauri.conf.json`.
2. Update [CHANGELOG.md](../CHANGELOG.md).
3. Commit, tag, and push:

```bash
git tag -a v0.0.1 -m "v0.0.1"
git push origin v0.0.1
```

GitHub Actions (`.github/workflows/release.yml`) builds on `v*` tags and attaches a **`.dmg`** installer to the release (no zip).

CI uses **ad-hoc signing** (`APPLE_SIGNING_IDENTITY=-`) unless you set the `APPLE_SIGNING_IDENTITY` repository secret to a Developer ID certificate name. Ad-hoc builds run on macOS but are not notarized; users may need to right-click → Open the first time.

## Local universal build

```bash
npm ci
npm run tauri build -- --target universal-apple-darwin
```

Artifacts: `target/universal-apple-darwin/release/bundle/macos/`

Or use:

```bash
./scripts/build-macos-release.sh
```

## Optional: code signing & notarization

For Gatekeeper-friendly downloads outside the App Store:

1. Copy [.env.example](../.env.example) to `.env` and set `APPLE_SIGNING_IDENTITY`.
2. Sign and notarize the DMG — see [Apple notarization docs](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution).

Entitlements for sandboxed builds: `src-tauri/Entitlements.plist` (not required for ad-hoc local builds).

## App Store

This project targets **direct open-source distribution**, not the Mac App Store. MAS-specific files (`Entitlements.mas.plist.example`, `PrivacyInfo.xcprivacy`) are kept in the repo but are **not** bundled by default (they break ad-hoc CI signing). To ship to the App Store, add `PrivacyInfo.xcprivacy` back under `bundle.macOS.files` in `tauri.macos.conf.json` and use a real `signingIdentity` with `hardenedRuntime: true`.
