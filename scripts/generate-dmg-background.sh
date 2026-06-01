#!/usr/bin/env bash
# Generate 1x and @2x DMG background PNGs from src-tauri/dmg/background.svg
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/src-tauri/dmg/background.svg"
OUT="$ROOT/src-tauri/dmg"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick (magick) is required to generate DMG backgrounds." >&2
  exit 1
fi

magick -background none "$SVG" -resize 660x400 "$OUT/background.png"
magick -background none "$SVG" -resize 1320x800 "$OUT/background@2x.png"

echo "Wrote $OUT/background.png and $OUT/background@2x.png"
