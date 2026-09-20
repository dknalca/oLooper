#!/usr/bin/env bash
# Build a self-contained oLooper.app for local testing.
# Usage: ./scripts/build.sh [--dev]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "${1:-}" in
  "") BUILD_MODE="release" ;;
  --dev) BUILD_MODE="debug" ;;
  *)
    echo "Usage: ./scripts/build.sh [--dev]" >&2
    exit 2
    ;;
esac

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required." >&2; exit 1; }

echo "Installing locked dependencies..."
pnpm install --frozen-lockfile

echo "Generating application icons..."
node scripts/generate-icons.mjs
test -s src-tauri/icons/icon.icns
test -s src-tauri/icons/icon.png

if [ "$BUILD_MODE" = "debug" ]; then
  echo "Building dev bundle..."
  pnpm run tauri build --debug
  SRC="src-tauri/target/debug/bundle/macos/oLooper.app"
else
  echo "Building release bundle..."
  pnpm run tauri build
  SRC="src-tauri/target/release/bundle/macos/oLooper.app"
fi

test -d "$SRC"
rm -rf ./oLooper.app
ditto "$SRC" ./oLooper.app

echo ""
echo "Done! App at:"
echo "  ./oLooper.app"
echo ""
echo "To launch:"
echo "  open oLooper.app"
