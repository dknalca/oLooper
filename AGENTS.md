# Agent Instructions

oLooper is a Tauri 2 app: React/TypeScript frontend in `src/`, Rust backend in `src-tauri/` (MSRV 1.87). The root package is the frontend; use pnpm and `pnpm-lock.yaml`. There is no configured lint command.

## Commands

- Develop: `pnpm install`, then `pnpm tauri dev`. Vite is fixed to port 1420; keep it aligned with `src-tauri/tauri.conf.json`.
- Frontend checks: `pnpm run typecheck` and `pnpm test`; focused test: `pnpm test -- src/importFlow.test.ts`.
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`; focus by appending a test-name filter (use `-- --exact` for exact matching).
- The ignored SWF fixture regression requires `OLOOPER_TURNTABLE_FIXTURE=/path/to/file.swf cargo test --manifest-path src-tauri/Cargo.toml -- --ignored turntable_fixture`. Real samples belong in gitignored `loopersFlash/`, never commits.
- macOS: `./scripts/build.sh [--dev | --native | --arm64 | --x64]` (default is Universal 2); `./scripts/package-dmg.sh [--arm64 | --x64]` packages an unsigned DMG. Windows: run `scripts/install-windows.ps1` in elevated PowerShell, restart the shell, then `scripts/build.ps1` (NSIS installer) or `scripts/build.ps1 -Dev` (unbundled debug executable).

## Architecture and constraints

- Backend commands/setup are in `src-tauri/src/lib.rs`; audio engine in `src-tauri/src/player/`; import parsers in `src-tauri/src/import/`; waveform/BPM analysis in `waveform.rs` and `analysis.rs`. SQLite schema and migrations are in `library/mod.rs` (current schema v10; add migrations there).
- Keep frontend Tauri command/dialog wrappers in `src/tauri.ts`; components should not call Tauri APIs directly. Drag/drop in `src/components/ImportBar.tsx` is the current `getCurrentWebview` exception.
- Imports run on the `olooper-import` worker with a separate SQLite connection. Completion uses `olooper:import-progress` events (`report` for SWF/EXE, `custom_report` for custom audio); frontend wait helpers subscribe to these events. SQLite WAL and busy timeout allow worker/read concurrency.
- The selected library root owns the catalog DB, managed audio/covers, copied SWF/EXE sources, and derived caches. Playlists reference ordered track IDs and never copy audio. Waveforms cache under `<library>/.olooper-cache/waveforms/`.
- Preserve Serato saved loops; do not expose loop-slot editing. CUE 1 is fixed at track start. MP3/WAV/AIFF use the legacy `Markers_` frame; preserve existing ID3 `Markers2` metadata.
- Never execute SWF/EXE projectors. Treat imported files as untrusted: retain parsing bounds/size checks, path sanitization, and validated/atomic writes. Removing a library entry must not delete original SWF/EXE inputs or external custom-audio sources.
- For non-trivial features, update/add a spec in `specs/`; record lasting architectural decisions in `docs/adr/`. Add regression coverage for parsing, persistence, serialization, and security-sensitive changes.
- `src-tauri/gen/` is generated and gitignored; `src-tauri/icons/` is committed and required to compile. Keep local data/artifacts (`loopersFlash/`, `audios/`, `library/`, `.dev/`, `oLooper*.app/`, `dist/`) out of commits.
