# Release guide (maintainers)

Trivor ships via [GitHub Releases](https://github.com/imboni/trivor/releases) as **`Trivor-{version}-macOS.dmg`** (universal: Apple Silicon + Intel).

## Version sources (keep in sync)

| File | Field |
|------|--------|
| [Cargo.toml](../Cargo.toml) | `[workspace.package] version` |
| [package.json](../package.json) | `"version"` |
| [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) | `"version"` |

After editing `package.json`, run `npm install` so [package-lock.json](../package-lock.json) stays aligned.

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
3. Commit, e.g. `chore(release): prepare v0.1.0`.
4. Tag and push:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin main
git push origin v0.1.0
```

Pushing `v*` triggers [.github/workflows/release.yml](../.github/workflows/release.yml), which:

- Builds a universal `.app` + `.dmg`
- Uploads **`Trivor-0.1.0-macOS.dmg`**
- Creates the GitHub Release with the **CHANGELOG section** for that version (not auto-generated commit lists)

Manual CI run (existing tag):

```bash
gh workflow run release.yml -f version=v0.1.0
```

## Signing

CI uses **ad-hoc signing** (`APPLE_SIGNING_IDENTITY=-`) unless the `APPLE_SIGNING_IDENTITY` repository secret is set. Ad-hoc builds are not notarized; users may need **Right-click → Open** the first time.

For Developer ID signing and notarization, see [Apple’s notarization guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution) and optional `.env` + [scripts/build-macos-release.sh](../scripts/build-macos-release.sh).

## Local universal build

```bash
npm ci
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

Artifacts: `src-tauri/target/universal-apple-darwin/release/bundle/`

Open With handlers for `.gltf`/`.glb` and folders: [tauri.macos.conf.json](../src-tauri/tauri.macos.conf.json), [Info.plist](../src-tauri/Info.plist).
