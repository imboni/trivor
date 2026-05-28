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

GitHub Actions (`.github/workflows/release.yml`) builds on `v*` tags and attaches `.app` / `.dmg` artifacts to the release when possible.

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

This project targets **direct open-source distribution**, not the Mac App Store. MAS-specific files (`Entitlements.mas.plist.example`, `PrivacyInfo.xcprivacy`) are kept for optional use only.
