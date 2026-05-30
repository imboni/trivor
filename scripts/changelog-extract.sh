#!/usr/bin/env bash
# Print the CHANGELOG section for a semver (e.g. 0.1.0 or v0.1.0).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1#v}"
CHANGELOG="${ROOT}/CHANGELOG.md"

if [[ -z "$VERSION" ]]; then
  echo "usage: changelog-extract.sh <version>" >&2
  exit 1
fi

if [[ ! -f "$CHANGELOG" ]]; then
  echo "missing ${CHANGELOG}" >&2
  exit 1
fi

awk -v ver="$VERSION" '
  BEGIN { found = 0 }
  $0 ~ "^## \\[" ver "\\]" { found = 1; next }
  found && $0 ~ "^## \\[" { exit }
  found { print }
' "$CHANGELOG"
