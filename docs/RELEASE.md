# Release guide (maintainers)

Trivor ships via [GitHub Releases](https://github.com/imboni/trivor/releases) as **`Trivor-{version}-macOS.dmg`** (universal: Apple Silicon + Intel).

## Version sources (keep in sync)

| File | Field |
|------|--------|
| [Cargo.toml](../Cargo.toml) | `[workspace.package] version` |
| [package.json](../package.json) | `"version"` |
| [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) | `"version"` |

After editing `package.json`, run `npm install --package-lock-only --ignore-scripts`
so [package-lock.json](../package-lock.json) stays aligned without changing installed
dependencies. Run the workspace checks to update the four local package versions
in [Cargo.lock](../Cargo.lock); external dependency versions should remain unchanged.

## Changelog workflow

We follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

1. **During development** — add user-visible changes under **`## [Unreleased]`** in [CHANGELOG.md](../CHANGELOG.md) (`Added` / `Changed` / `Fixed` / `Removed`).
2. **Before tagging** — move `[Unreleased]` entries into a new version section, e.g. `## [0.1.1] - YYYY-MM-DD`, and leave `[Unreleased]` empty again.
3. **On tag push** — CI reads that section and publishes it as the GitHub Release body (see below).

Preview notes locally:

```bash
chmod +x scripts/changelog-extract.sh   # once
./scripts/changelog-extract.sh 0.1.0
```

## Tag and publish

1. Bump version in the three files above.
2. Finalize [CHANGELOG.md](../CHANGELOG.md) (dated version section, empty `[Unreleased]`).
3. Update the [product website](../website/README.md) for the release: English and Chinese features, format/preview limits, installation guidance, the HTML fallback and metadata. Set `data-site-version` on the HTML root to the package version, update the HTML release notes link and `RELEASE_NOTES_URL` in `website/main.js` to the matching release tag, and update `main.js?v={version}` and `styles.css?v={version}` in the HTML to avoid reusing an older release's cached resources. Run `node scripts/check-website-release.mjs` and review both languages, themes and desktop/mobile layouts locally.
4. Commit, e.g. `chore(release): prepare v0.1.0`.
5. Tag and push:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin main
git push origin v0.1.0
```

Pushing `v*` triggers [.github/workflows/release.yml](../.github/workflows/release.yml), which:

- Uses a macOS 15 build runner, while retaining the macOS 13 deployment target
- Checks website version, release notes URLs and JavaScript/CSS version queries before installing dependencies; stale metadata fails the release build with update instructions
- Builds a universal `.app` + `.dmg`
- Uploads **`Trivor-0.1.0-macOS.dmg`**
- Creates the GitHub Release with the **CHANGELOG section** for that version (not auto-generated commit lists)

Manual CI run (existing tag):

```bash
gh workflow run release.yml -f version=v0.1.0
```

## Verify the published website

App releases and GitHub Pages use separate workflows. A tag push alone does not
deploy the website. Push the website changes to `main` and wait for the
[Deploy website workflow](../.github/workflows/pages.yml) to succeed for that
commit. If a redeploy is needed without file changes, run
`gh workflow run pages.yml --ref main`.

After the app release and Pages deployment finish, open
[the live site](https://imboni.github.io/trivor/) and confirm the displayed version,
English/Chinese release features, release notes link and download destination.
Check that `/releases/latest` reaches the published stable release. Refresh with
cache disabled if the CDN or browser still shows the previous page, and verify
the served HTML's `data-site-version` and `main.js` content match the release.
The metadata check prevents a forgotten version update; it does not establish
that the copy is accurate or that deployment has completed.

## Signing

In-app updates download into the app's cache and open the validated DMG in Finder.
The user installs it by dragging Trivor to Applications; the sandboxed app stays
running and does not overwrite its own bundle or forcibly unmount installer volumes.

CI uses **ad-hoc signing** (`APPLE_SIGNING_IDENTITY=-`) unless the `APPLE_SIGNING_IDENTITY` repository secret is set. Ad-hoc builds are not notarized; users may need **Right-click → Open** the first time.

For Developer ID signing and notarization, see [Apple’s notarization guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution) and optional `.env` + [scripts/build-macos-release.sh](../scripts/build-macos-release.sh).

The macOS `beforeBundleCommand` runs [prepare-macos-bundle.mjs](../scripts/prepare-macos-bundle.mjs),
which calls [prepare-macos-sidecar.mjs](../scripts/prepare-macos-sidecar.mjs)
for Apple Silicon, Intel, and universal builds. It signs a copy of `gltfpack` using
the configured signing identity and [Entitlements.sidecar.plist](../src-tauri/Entitlements.sidecar.plist),
then includes it through `bundle.macOS.files`. The generated copy lives in the ignored
`src-tauri/.bundle/` directory. A missing binary or failed signature stops bundling.
For Developer ID builds, the same `APPLE_SIGNING_IDENTITY` certificate must be available
in the build machine's keychain before the hook runs.

The hook also builds `TrivorQuickLook.appex` and `TrivorThumbnail.appex` with the installed Command Line Tools
Swift compiler for the selected architectures. Its version and bundle identifier
are derived from the app configuration. Each extension embeds its own bounded,
offline model-viewer page and is signed with sandbox + user-selected **read-only**
file access plus the network-client entitlement required for WebKit's service
startup, then copied to `Contents/PlugIns/` through `bundle.macOS.files`.
Its content security policy and local scheme handler restrict all model resources
to the selected self-contained file and bundled decoders.
App, helper and both extension signatures are verified together after bundling;
the extensions must not be re-signed using the main app's broader entitlements.

This separate signature is necessary because Tauri CLI 2.11 applies the main app's
entitlements to every `externalBin`. macOS therefore overrides `externalBin` with
an empty list; other platforms keep the existing sidecar configuration. The main app
retains its original sandbox/file/network permissions. The helper has only sandbox
and inheritance enabled, as required by [Apple's sandbox inheritance rules](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).

After bundling, verify the final app and inspect all four entitlement sets:

```bash
codesign --verify --deep --strict target/universal-apple-darwin/release/bundle/macos/Trivor.app
codesign --display --entitlements :- target/universal-apple-darwin/release/bundle/macos/Trivor.app
codesign --display --entitlements :- target/universal-apple-darwin/release/bundle/macos/Trivor.app/Contents/MacOS/gltfpack
codesign --display --entitlements :- target/universal-apple-darwin/release/bundle/macos/Trivor.app/Contents/PlugIns/TrivorQuickLook.appex
codesign --display --entitlements :- target/universal-apple-darwin/release/bundle/macos/Trivor.app/Contents/PlugIns/TrivorThumbnail.appex
node scripts/verify-macos-bundle.mjs target/universal-apple-darwin/release/bundle/macos/Trivor.app arm64 x86_64
```

## Local universal build

```bash
npm ci
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

Artifacts: `target/universal-apple-darwin/release/bundle/`

Open With handlers for `.gltf`/`.glb`, `.obj`/`.stl` and folders: [tauri.macos.conf.json](../src-tauri/tauri.macos.conf.json), [Info.plist](../src-tauri/Info.plist).

Quick Look preview/thumbnail scope, build commands and registration diagnostics:
[quick-look/README.md](../quick-look/README.md). Before release, test Finder Space
preview with the installed app, including closing/reopening and malformed files.
Verify that `QLThumbnailGenerator` returns a real thumbnail representation for
fresh GLB fixtures; a generic file icon does not establish provider success.
