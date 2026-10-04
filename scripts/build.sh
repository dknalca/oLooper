#!/usr/bin/env bash
# Build a self-contained oLooper.app. Release builds are Universal 2 by default.
# Usage: ./scripts/build.sh [--dev | --native]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "${1:-}" in
  "") BUILD_MODE="release"; BUILD_TARGET="universal-apple-darwin" ;;
  --dev) BUILD_MODE="debug"; BUILD_TARGET="" ;;
  --native) BUILD_MODE="release"; BUILD_TARGET="" ;;
  *)
    echo "Usage: ./scripts/build.sh [--dev | --native]" >&2
    exit 2
    ;;
esac

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required." >&2; exit 1; }

if [ "$BUILD_TARGET" = "universal-apple-darwin" ]; then
  [ "$(uname -s)" = "Darwin" ] || {
    echo "Universal macOS builds require macOS and Xcode." >&2
    exit 1
  }
  command -v rustup >/dev/null || { echo "rustup is required for Universal builds." >&2; exit 1; }
  echo "Installing/checking Rust targets for Universal macOS..."
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
fi

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
elif [ "$BUILD_TARGET" = "universal-apple-darwin" ]; then
  echo "Building Universal macOS bundle (Intel + Apple Silicon)..."
  pnpm run tauri build --target "$BUILD_TARGET"
  SRC="src-tauri/target/$BUILD_TARGET/release/bundle/macos/oLooper.app"
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
