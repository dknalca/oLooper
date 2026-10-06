#!/usr/bin/env bash
# Build a self-contained oLooper.app. Release builds are Universal 2 by default.
# Usage: ./scripts/build.sh [--dev | --native | --arm64 | --x64]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Keep the generated universal binary and its bundle metadata compatible with
# the oldest supported macOS release (Big Sur).
export MACOSX_DEPLOYMENT_TARGET="11.0"

case "${1:-}" in
  "") BUILD_MODE="release"; BUILD_TARGET="universal-apple-darwin"; APP_NAME="oLooper" ;;
  --dev) BUILD_MODE="debug"; BUILD_TARGET=""; APP_NAME="oLooper" ;;
  --native) BUILD_MODE="release"; BUILD_TARGET=""; APP_NAME="oLooper" ;;
  --arm64) BUILD_MODE="release"; BUILD_TARGET="aarch64-apple-darwin"; APP_NAME="oLooper-arm64" ;;
  --x64|--intel) BUILD_MODE="release"; BUILD_TARGET="x86_64-apple-darwin"; APP_NAME="oLooper-x64" ;;
  *)
    echo "Usage: ./scripts/build.sh [--dev | --native | --arm64 | --x64]" >&2
    exit 2
    ;;
esac

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required." >&2; exit 1; }

if [ -n "$BUILD_TARGET" ]; then
  [ "$(uname -s)" = "Darwin" ] || {
    echo "macOS app builds require macOS and Xcode." >&2
    exit 1
  }
  command -v rustup >/dev/null || { echo "rustup is required for target-specific builds." >&2; exit 1; }
  if [ "$BUILD_TARGET" = "universal-apple-darwin" ]; then
    echo "Installing/checking Rust targets for Universal macOS..."
    rustup target add aarch64-apple-darwin x86_64-apple-darwin
  else
    echo "Installing/checking Rust target $BUILD_TARGET..."
    rustup target add "$BUILD_TARGET"
  fi
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
elif [ -n "$BUILD_TARGET" ]; then
  echo "Building macOS bundle for $BUILD_TARGET..."
  pnpm run tauri build --target "$BUILD_TARGET"
  SRC="src-tauri/target/$BUILD_TARGET/release/bundle/macos/oLooper.app"
else
  echo "Building release bundle..."
  pnpm run tauri build
  SRC="src-tauri/target/release/bundle/macos/oLooper.app"
fi

test -d "$SRC"
APP_OUT="$ROOT/$APP_NAME.app"
rm -rf "$APP_OUT"
ditto "$SRC" "$APP_OUT"

echo ""
echo "Done! App at:"
echo "  ./$APP_NAME.app"
echo ""
echo "To launch:"
echo "  open '$APP_NAME.app'"
