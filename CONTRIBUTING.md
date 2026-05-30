# Contributing to Trivor

Thank you for your interest in contributing!

## Development setup

1. Fork and clone the repository.
2. Install [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/) 20+.
3. Run:

```bash
npm install
npm run tauri dev
```

## Pull requests

1. Open an issue for large changes (optional but appreciated).
2. Create a branch from `main`.
3. Keep PRs focused; match existing code style.
4. Verify the app builds:

```bash
npm run build
cargo build -p trivor
```

5. Update [CHANGELOG.md](CHANGELOG.md) under **`[Unreleased]`** for user-visible changes (`Added` / `Changed` / `Fixed`). Release maintainers move entries into a versioned section when tagging; see [docs/RELEASE.md](docs/RELEASE.md).

## Translations

UI strings live in `crates/i18n/src/lib.rs`. Add keys to `MessageKey`, both locales in `I18n::t`, and mirror fields on `UiBundle` / `src/types.ts` when exposed to the frontend.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
