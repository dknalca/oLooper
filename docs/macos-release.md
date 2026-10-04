# macOS Release

Create an unsigned Universal 2 macOS image locally (Intel x86_64 and Apple
Silicon arm64):

```sh
./scripts/build.sh
./scripts/package-dmg.sh
```

The release build requires macOS, Xcode, and rustup. The build script installs
the Rust targets for both architectures and invokes Tauri with
`--target universal-apple-darwin`. Use `./scripts/build.sh --native` only when a
single-architecture release build is specifically needed; `--dev` remains a
native-architecture debug build.

The result is `dist/oLooper-<version>-unsigned.dmg`. It is not suitable for
normal Gatekeeper distribution until signed and notarized.

Verify a built app contains both architectures with:

```sh
lipo -archs oLooper.app/Contents/MacOS/oLooper
```

The output should include both `x86_64` and `arm64`.

With a Developer ID Application identity installed outside this repository:

```sh
codesign --force --deep --options runtime --sign "Developer ID Application: YOUR NAME (TEAMID)" oLooper.app
./scripts/package-dmg.sh
xcrun notarytool submit dist/oLooper-<version>-unsigned.dmg --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple dist/oLooper-<version>-unsigned.dmg
```

Never store the certificate, Apple ID password, API key, or keychain profile in
the repository. Rename the final artifact only after notarization succeeds.
