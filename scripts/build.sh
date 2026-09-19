#!/bin/bash
# Build oLooper.app for local testing
# Usage: ./scripts/build.sh [--dev]

set -e

export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

if [ "$1" = "--dev" ]; then
  echo "Building dev bundle..."
  pnpm run tauri build --debug
  SRC="src-tauri/target/debug/bundle/macos/oLooper.app"
else
  echo "Building release bundle..."
  pnpm run tauri build
  SRC="src-tauri/target/release/bundle/macos/oLooper.app"
fi

cp -R "$SRC" ./oLooper.app

echo ""
echo "Done! App at:"
echo "  ./oLooper.app"
echo ""
echo "To launch:"
echo "  open oLooper.app"
