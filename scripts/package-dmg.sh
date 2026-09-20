#!/usr/bin/env bash
# Produce an unsigned macOS DMG. Signing and notarization remain external steps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/oLooper.app"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
OUT_DIR="$ROOT/dist"
DMG="$OUT_DIR/oLooper-$VERSION-unsigned.dmg"

command -v hdiutil >/dev/null || { echo "This script must run on macOS." >&2; exit 1; }
test -d "$APP" || { echo "Build the app first: ./scripts/build.sh" >&2; exit 1; }

mkdir -p "$OUT_DIR"
rm -f "$DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/oLooper.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "oLooper" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
echo "Unsigned DMG: $DMG"
