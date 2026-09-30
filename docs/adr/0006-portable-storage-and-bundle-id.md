# ADR 0006 - Portable storage and bundle identifier

- Status: accepted
- Date: 2026-09-19

## Decision

- The Tauri bundle identifier is `com.olooper`, without the `.app` bundle suffix.
- On first launch, the user confirms a library root, defaulting to `~/Documents/oLooper_data`.
- Imported SWF/EXE copies, extracted audio, SQLite catalog, and derived caches stay inside the selected library. The selected root is remembered as an application preference, not as a file beside the app bundle.
- Existing `olooper-library.json` selections from older versions are read once and the obsolete file beside the app is removed.

## Consequences

- Correcting the bundle identifier does not relocate the selected library or its catalog.
- A prior selected external library remains unchanged on disk; changing libraries does not delete data in the old root.
