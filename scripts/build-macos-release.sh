#!/usr/bin/env bash
# Build signed universal macOS app + DMG for Trivor.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "==> Installing frontend dependencies"
npm ci

echo "==> Building universal macOS bundles (app + dmg)"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  export APPLE_SIGNING_IDENTITY
  echo "    Signing identity: $APPLE_SIGNING_IDENTITY"
fi

npm run tauri build -- --target universal-apple-darwin

OUT="target/universal-apple-darwin/release/bundle/macos"
echo ""
echo "Done. Artifacts:"
ls -la "$OUT" 2>/dev/null || ls -la target/release/bundle/macos 2>/dev/null || true
echo ""
echo "Next: optional signing/notarization (see docs/RELEASE.md)"
