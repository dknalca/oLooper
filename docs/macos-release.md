# macOS Release

Create an unsigned distributable image locally:

```sh
./scripts/build.sh
./scripts/package-dmg.sh
```

The result is `dist/oLooper-<version>-unsigned.dmg`. It is not suitable for
normal Gatekeeper distribution until signed and notarized.

With a Developer ID Application identity installed outside this repository:

```sh
codesign --force --deep --options runtime --sign "Developer ID Application: YOUR NAME (TEAMID)" oLooper.app
./scripts/package-dmg.sh
xcrun notarytool submit dist/oLooper-<version>-unsigned.dmg --keychain-profile YOUR_PROFILE --wait
xcrun stapler staple dist/oLooper-<version>-unsigned.dmg
```

Never store the certificate, Apple ID password, API key, or keychain profile in
the repository. Rename the final artifact only after notarization succeeds.
