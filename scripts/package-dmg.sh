#!/usr/bin/env bash
# Produce an unsigned macOS DMG. Signing and notarization remain external steps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
OUT_DIR="$ROOT/dist"
case "${1:-}" in
  "") APP_NAME="oLooper"; ARCH_SUFFIX="" ;;
  --arm64) APP_NAME="oLooper-arm64"; ARCH_SUFFIX="-arm64" ;;
  --x64|--intel) APP_NAME="oLooper-x64"; ARCH_SUFFIX="-x64" ;;
  *)
    echo "Usage: ./scripts/package-dmg.sh [--arm64 | --x64]" >&2
    exit 2
    ;;
esac
APP="$ROOT/$APP_NAME.app"
DMG="$OUT_DIR/oLooper-$VERSION$ARCH_SUFFIX-unsigned.dmg"

command -v hdiutil >/dev/null || { echo "This script must run on macOS." >&2; exit 1; }
test -d "$APP" || { echo "Build the app first: ./scripts/build.sh ${1:-}" >&2; exit 1; }

mkdir -p "$OUT_DIR"
rm -f "$DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/oLooper.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "oLooper" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
echo "Unsigned DMG: $DMG"
