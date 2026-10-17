# Agent Instructions

oLooper is a Tauri 2 app: React/TypeScript frontend in `src/`, Rust backend in `src-tauri/` (MSRV 1.87). The root package is the frontend; use pnpm and `pnpm-lock.yaml` despite the existing `package-lock.json`. CI uses Node 24 and pnpm 12.9.1.

## Commands

- Develop: `pnpm install --frozen-lockfile`, then `pnpm tauri dev` (starts Vite via Tauri's hook). Vite is fixed to port 1420; keep it aligned with `src-tauri/tauri.conf.json`.
- Frontend checks: `pnpm run typecheck` and `pnpm test`; focused test: `pnpm test -- src/importFlow.test.ts`. There is no configured lint or formatter command.
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`; focus by appending a test-name filter (use `-- --exact` for exact matching).
- The ignored SWF fixture regression requires `OLOOPER_TURNTABLE_FIXTURE=/path/to/file.swf cargo test --manifest-path src-tauri/Cargo.toml -- --ignored turntable_fixture`. Real samples belong in gitignored `loopersFlash/`, never commits.
- macOS: `./scripts/build.sh [--dev | --native | --arm64 | --x64]` (default is Universal 2; sets deployment target 11.0 and regenerates icons), then `./scripts/package-dmg.sh [--arm64 | --x64]` for an unsigned DMG; match architecture flags. See `docs/macos-release.md`.
- Windows: run `scripts/install-windows.ps1` in elevated PowerShell, restart the shell, then `scripts/build.ps1` (x64 MSVC NSIS installer in `dist/installers/`) or `scripts/build.ps1 -Dev` (unbundled debug executable).

## Architecture and constraints

- Backend commands/setup are in `src-tauri/src/lib.rs`; audio engine in `src-tauri/src/player/`; import parsers in `src-tauri/src/import/`; waveform/BPM analysis in `waveform.rs` and `analysis.rs`. SQLite schema and migrations are in `library/mod.rs` (current schema v10; add migrations there).
- Keep frontend Tauri command/dialog wrappers and typed IPC contracts in `src/tauri.ts`, in sync with Rust DTOs and command registration in `src-tauri/src/lib.rs`. Drag/drop in `src/components/ImportBar.tsx` is the current `getCurrentWebview` exception.
- Imports enqueue on the `olooper-import` worker with a separate SQLite connection; command return is not job completion. Subscribe before enqueueing via the wait helpers in `src/tauri.ts` to avoid missing fast completions. Final `olooper:import-progress` events carry `report` (SWF/EXE) or `custom_report` (custom audio). Preserve SQLite WAL and busy timeout for worker/read concurrency.
- The selected library root owns the catalog DB, managed audio/covers, copied SWF/EXE sources, and derived caches. Playlists reference ordered track IDs and never copy audio. Waveforms cache under `<library>/.olooper-cache/waveforms/`.
- Source-backed tracks use `audio_storage = "embedded"` and virtual `embedded:<id>` playback paths, not audio files. Load library tracks by ID; decode the referenced SWF/EXE without materializing audio. Container copying is opt-in for either import mode; `source_managed` distinguishes copies from originals. These tracks have only fixed CUE 1 and no Serato writes, conversion, or native audio drag-out (ADR 0020).
- Managed audio tags are the source of truth for CUEs, not SQLite. CUE 1 is fixed at track start. Preserve Serato saved loops; do not expose loop-slot editing. MP3/WAV/AIFF update legacy `Markers_` while preserving existing ID3 `Markers2`; stage and validate writes before replacing managed files (ADR 0014).
- Never execute SWF/EXE projectors. Treat imported files as untrusted: retain parsing bounds/size checks, path sanitization, and validated/atomic writes. Removing a library entry must not delete original SWF/EXE inputs or external custom-audio sources.
- For non-trivial features, update/add a spec in `specs/`; record lasting architectural decisions in `docs/adr/`. Add regression coverage for parsing, persistence, serialization, and security-sensitive changes.
- `src-tauri/gen/` is generated and gitignored; `src-tauri/icons/` is committed and required to compile. Keep local data/artifacts (`loopersFlash/`, `audios/`, `library/`, `.dev/`, `oLooper*.app/`, `dist/`) out of commits.
- Version bumps span `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; release workflows validate the tag against the Tauri config version.
