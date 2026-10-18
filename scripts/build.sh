#!/usr/bin/env bash
# Build a self-contained oLooper.app. Release builds are Universal 2 by default.
# Usage: ./scripts/build.sh [--dev] [--native | --arm64 | --x64] [--no-bundle]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Keep the generated universal binary and its bundle metadata compatible with
# the oldest supported macOS release (Big Sur).
export MACOSX_DEPLOYMENT_TARGET="11.0"

BUILD_MODE="release"
ARCH=""
NO_BUNDLE=false
for option in "$@"; do
  case "$option" in
    --dev) BUILD_MODE="debug" ;;
    --no-bundle) NO_BUNDLE=true ;;
    --native|--arm64|--x64|--64|--intel)
      requested_arch="$option"
      case "$requested_arch" in --64|--intel) requested_arch="--x64" ;; esac
      if [ -n "$ARCH" ] && [ "$ARCH" != "$requested_arch" ]; then
        echo "Choose only one architecture option." >&2
        exit 2
      fi
      ARCH="$requested_arch"
      ;;
    -h|--help)
      echo "Usage: ./scripts/build.sh [--dev] [--native | --arm64 | --x64] [--no-bundle]"
      echo "  --dev      Build a debug app for faster local testing."
      echo "  --native   Build only for this Mac's architecture."
      echo "  --arm64    Build an Apple Silicon app."
      echo "  --x64      Build an Intel app (aliases: --64, --intel)."
      echo "  --no-bundle Build only the debug executable; requires --dev."
      exit 0
      ;;
    *)
      echo "Unknown option: $option" >&2
      echo "Usage: ./scripts/build.sh [--dev] [--native | --arm64 | --x64] [--no-bundle]" >&2
      exit 2
      ;;
  esac
done

case "$ARCH" in
  --native) BUILD_TARGET=""; APP_NAME="oLooper" ;;
  --arm64) BUILD_TARGET="aarch64-apple-darwin"; APP_NAME="oLooper-arm64" ;;
  --x64|--64|--intel) BUILD_TARGET="x86_64-apple-darwin"; APP_NAME="oLooper-x64" ;;
  "")
    if [ "$BUILD_MODE" = "debug" ]; then
      BUILD_TARGET=""
    else
      BUILD_TARGET="universal-apple-darwin"
    fi
    APP_NAME="oLooper"
    ;;
esac

if [ "$NO_BUNDLE" = true ] && [ "$BUILD_MODE" != "debug" ]; then
  echo "--no-bundle can only be used with --dev." >&2
  exit 2
fi

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

if [ "$NO_BUNDLE" = false ]; then
  echo "Generating application icons..."
  node scripts/generate-icons.mjs
  test -s src-tauri/icons/icon.icns
  test -s src-tauri/icons/icon.png
fi

if [ "$NO_BUNDLE" = true ]; then
  BUILD_ARGS=(build --debug --no-bundle)
  if [ -n "$BUILD_TARGET" ]; then BUILD_ARGS+=(--target "$BUILD_TARGET"); fi
  pnpm run tauri "${BUILD_ARGS[@]}"
  if [ -n "$BUILD_TARGET" ]; then
    echo "Debug executable: src-tauri/target/$BUILD_TARGET/debug/olooper"
  else
    echo "Debug executable: src-tauri/target/debug/olooper"
  fi
  exit 0
fi

if [ "$BUILD_MODE" = "debug" ]; then
  if [ -n "$BUILD_TARGET" ]; then
    echo "Building debug bundle for $BUILD_TARGET..."
    pnpm run tauri build --debug --target "$BUILD_TARGET"
    SRC="src-tauri/target/$BUILD_TARGET/debug/bundle/macos/oLooper.app"
  else
    echo "Building native debug bundle..."
    pnpm run tauri build --debug
    SRC="src-tauri/target/debug/bundle/macos/oLooper.app"
  fi
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
