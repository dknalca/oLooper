# ADR 0006 - Portable storage and bundle identifier

- Status: accepted
- Date: 2026-09-19

## Decision

- The Tauri bundle identifier is `com.olooper`, without the `.app` bundle suffix.
- User loopers are stored beside the executable or macOS app bundle in `loopersFlash/`.
- On first launch, the user confirms a library root, defaulting to `library/` beside the app. Its portable selection file is stored beside the app, not in identifier-derived app data.

## Consequences

- Correcting the bundle identifier does not relocate sources, the portable selection, user audio, or the SQLite catalog.
- A prior selected external library remains unchanged on disk and can be imported into the portable library explicitly.
