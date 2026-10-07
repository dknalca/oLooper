# Windows compatibility audit — 2026-10-07

## Scope and environment

Reviewed source-backed SWF/EXE playback, import-mode prompting, looper deletion,
frontend keyboard handling, and Windows x64 build/release configuration at
`d4b440c` plus the local changes. Checks were executed on macOS Intel, not
Windows. A successful Windows build or interactive Windows playback test has
not been established by this audit.

## Findings addressed

- Group deletion previously chose all file deletion behavior from the first
  track's storage mode. It now collects extracted audio and embedded covers
  per track, including groups containing both storage modes.
- The import-mode prompt now focuses its controls, confines keyboard Tab
  navigation, supports Escape cancellation, and restores focus. This also
  keeps global playback shortcuts from intercepting Space in the prompt.
- ADR 0020 now matches the requested deletion policy: delete unreferenced
  library-owned container copies while preserving external original inputs.
- Added `.github/workflows/check-windows.yml` to test current branch changes
  on Windows MSVC and build an x64 NSIS installer. The existing release workflow
  builds a selected release tag, so it alone does not validate local changes.

## Compatibility review

- Import buttons, menu commands, and webview drops ask once per SWF/EXE batch;
  ordinary audio import does not ask. Cancel occurs before import jobs start.
- Frontend import routing accepts Windows path separators and case-insensitive
  extensions. Existing helper tests include Windows-style paths.
- Source-backed decode uses portable Rust filesystem operations and the same
  bounded SWF/EXE parsers on both platforms. EXE projectors are parsed, never
  executed. The engine receives decoded PCM and a track-specific playback key.
- Decode reads the container into memory and closes the read handle before
  playback; it does not maintain an open container handle for streaming.
- Deletion stages assets in a quarantine directory on the library volume,
  deletes SQLite records, and restores files on catalog deletion failure.
  Source-copy candidates are regular files within the managed `loopersFlash`
  folder. External original inputs are excluded.
- Windows build scripts explicitly target `x86_64-pc-windows-msvc`, regenerate
  the ICO, validate the executable's PE x64 architecture, and check that a fresh
  NSIS installer was produced. Windows Serato replacement has a separate
  backup/restore path for filesystem replacement semantics.

## Regression coverage and local results

- Rust suite: **178 passed, 0 failed, 3 ignored**.
- Frontend suite: **18 passed**.
- TypeScript typecheck and frontend production build passed.
- New deletion tests cover both SWF/EXE formats and both storage modes,
  keeping the container while a loop remains, restoring staged files after a
  SQLite failure, mixed-mode groups, shared container references, and external
  original preservation. These tests are enabled on Windows as well as macOS.
- Extended source-backed decode coverage with a synthetic EXE containing a
  valid SWF, checking decoded PCM equivalence, unknown sound rejection,
  modified-container rejection, and missing-container rejection.

## Remaining Windows verification

Run the new CI workflow after the changes are published, or on Windows run
`pnpm run typecheck`, `pnpm test`,
`cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc`,
and `scripts/build.ps1`.

Interactive acceptance still needs a Windows machine with WebView2 and audio
output: browse/drop real SWF and EXE files in each mode, cancel the mode prompt,
play/seek/loop tracks, delete a looper, verify managed files are removed and
external originals remain. The three ignored fixture tests were not run here.
