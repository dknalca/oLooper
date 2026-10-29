# macOS Release

Create an unsigned Universal 2 macOS image locally (Intel x86_64 and Apple
Silicon arm64):

```sh
./scripts/build.sh
./scripts/package-dmg.sh
```

The release build requires macOS, Xcode, and rustup. The build script installs
the Rust targets for both architectures and invokes Tauri with
`--target universal-apple-darwin`. For faster architecture-specific builds and
testing, build Intel or Apple Silicon separately:

```sh
./scripts/build.sh --x64       # outputs oLooper-x64.app
./scripts/package-dmg.sh --x64

# For quicker iteration, build an x64 debug app (also accepts --64).
./scripts/build.sh --dev --x64

# Fastest compile check: build a debug executable without creating an app bundle.
./scripts/build.sh --dev --x64 --no-bundle

./scripts/build.sh --arm64     # outputs oLooper-arm64.app
./scripts/package-dmg.sh --arm64
```

The explicit target flags can cross-compile from either Mac architecture.
`./scripts/build.sh --native` remains a single-architecture build for the host;
`--dev` uses debug optimizations and can be combined with `--native`, `--arm64`,
or `--x64` for faster iterative testing. Add `--no-bundle` to compile only the
executable and skip icon generation/bundling; this mode requires `--dev`. The
release flags and package script are unchanged.

The bundle declares macOS 11.0 (Big Sur) as its minimum and the build sets
`MACOSX_DEPLOYMENT_TARGET=11.0`. Test the release on macOS 11 before claiming
runtime compatibility; previous releases were verified on macOS 12.
The frontend uses Tailwind CSS 3 to avoid Tailwind 4's Safari 16.4 CSS baseline,
and import job IDs use `crypto.getRandomValues` with a fallback. Big Sur's
WebKit 14.1 remains the minimum runtime target to verify on-device.

The result is `dist/oLooper-<version>-unsigned.dmg`. **All oLooper macOS releases
are intentionally unsigned and unnotarized.** The project does not enroll in the
Apple Developer Program or plan to add Developer ID signing/notarization. Users
approve oLooper for their own Mac using the one-app Gatekeeper instructions in
the [README](../README.md#macos--intel-and-apple-silicon). This does not disable
Gatekeeper globally. See [ADR 0026](adr/0026-unsigned-macos-distribution.md).

Verify a Universal bundle contains both architectures with:

```sh
lipo -archs oLooper.app/Contents/MacOS/oLooper
```

The output should include both `x86_64` and `arm64`. A single-architecture
bundle contains only the architecture selected by its build flag.
