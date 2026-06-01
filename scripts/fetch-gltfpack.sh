#!/usr/bin/env bash
# Download meshoptimizer gltfpack sidecars for macOS (Trivor large-model preview).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/bin"
mkdir -p "$BIN"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -sL -o "$TMP/arm.zip" "https://github.com/zeux/meshoptimizer/releases/download/v1.1/gltfpack-macos.zip"
curl -sL -o "$TMP/intel.zip" "https://github.com/zeux/meshoptimizer/releases/download/v1.1/gltfpack-macos-intel.zip"
unzip -o -j "$TMP/arm.zip" gltfpack -d "$TMP/arm"
unzip -o -j "$TMP/intel.zip" gltfpack -d "$TMP/intel"
mv "$TMP/arm/gltfpack" "$BIN/gltfpack-aarch64-apple-darwin"
mv "$TMP/intel/gltfpack" "$BIN/gltfpack-x86_64-apple-darwin"
lipo -create \
  "$BIN/gltfpack-aarch64-apple-darwin" \
  "$BIN/gltfpack-x86_64-apple-darwin" \
  -output "$BIN/gltfpack-universal-apple-darwin"
chmod +x "$BIN/gltfpack-"*
echo "Installed:"
ls -lh "$BIN"/gltfpack-*
