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

./scripts/build.sh --arm64     # outputs oLooper-arm64.app
./scripts/package-dmg.sh --arm64
```

The explicit target flags can cross-compile from either Mac architecture.
`./scripts/build.sh --native` remains a single-architecture build for the host;
`--dev` remains a native-architecture debug build.

The bundle declares macOS 11.0 (Big Sur) as its minimum and the build sets
`MACOSX_DEPLOYMENT_TARGET=11.0`. Test the release on macOS 11 before claiming
runtime compatibility; previous releases were verified on macOS 12.
The frontend uses Tailwind CSS 3 to avoid Tailwind 4's Safari 16.4 CSS baseline,
and import job IDs use `crypto.getRandomValues` with a fallback. Big Sur's
WebKit 14.1 remains the minimum runtime target to verify on-device.

The result is `dist/oLooper-<version>-unsigned.dmg`. It is not suitable for
normal Gatekeeper distribution until signed and notarized.

Verify a Universal bundle contains both architectures with:

```sh
lipo -archs oLooper.app/Contents/MacOS/oLooper
```

The output should include both `x86_64` and `arm64`. A single-architecture
bundle contains only the architecture selected by its build flag.

With a Developer ID Application identity installed outside this repository:

```sh
codesign --force --deep --options runtime --sign "Developer ID Application: YOUR NAME (TEAMID)" oLooper.app
./scripts/package-dmg.sh
xcrun notarytool submit dist/oLooper-<version>-unsigned.dmg --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple dist/oLooper-<version>-unsigned.dmg
```

Never store the certificate, Apple ID password, API key, or keychain profile in
the repository. Rename the final artifact only after notarization succeeds.
