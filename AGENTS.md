# Agent Instructions

oLooper is a Tauri 2 desktop app: React/TypeScript in `src/`, Rust in `src-tauri/`; Rust MSRV is 1.87. The root package is the frontend; there is no configured lint command.

## Commands

- Use `pnpm` with `pnpm-lock.yaml`. Dev: `pnpm install`, then `pnpm tauri dev`. Vite uses fixed port 1420; keep it aligned with `src-tauri/tauri.conf.json`.
- Frontend: `pnpm run typecheck`, `pnpm test`; focused test: `pnpm vitest run src/importFlow.test.ts`.
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml`; focused test: add a test-name filter (and `-- --exact` for exact matching).
- The ignored SWF fixture regression requires `OLOOPER_TURNTABLE_FIXTURE=/path/to/file.swf cargo test --manifest-path src-tauri/Cargo.toml -- --ignored turntable_fixture`. Keep real samples in gitignored `loopersFlash/`, never in commits.
- macOS bundle: `./scripts/build.sh [--dev | --native]`; `./scripts/package-dmg.sh` packages an unsigned DMG. Windows: `scripts/install-windows.ps1` (elevated PowerShell) installs prerequisites; restart the shell, then use `scripts/build.ps1` for an NSIS installer under `dist/installers/` or `scripts/build.ps1 -Dev` for an unbundled debug executable. Windows regenerates `icon.ico` from `src-tauri/icons/icon.png` via `scripts/generate-windows-icon.mjs`; `src-tauri/build.rs` watches the ICO so the embedded executable icon is rebuilt.

## Architecture and constraints

- Keep frontend Tauri command/dialog wrappers in `src/tauri.ts`; components should not call Tauri APIs directly. Current drag/drop exception: `getCurrentWebview` in `src/components/ImportBar.tsx`.
- Backend setup and commands: `src-tauri/src/lib.rs`; audio engine: `player/`; import parsers: `import/`; waveform/BPM analysis: `waveform.rs`, `analysis.rs`. SQLite schema and migrations live in `library/mod.rs` (current schema v6; add migrations there).
- Imports run on the `olooper-import` worker with a separate SQLite connection. Commands enqueue work; completion is emitted on `olooper:import-progress`, with final SWF/EXE `report` or custom-audio `custom_report`. Frontend `import*AndWait()` helpers subscribe and await completion. SQLite WAL and busy timeout support worker/read concurrency.
- The selected library root owns catalog SQLite, extracted/managed audio and cover copies, copied SWF/EXE sources, and derived caches. Catalog fields are sourced from SQLite; four CUEs are stored in managed audio tags (CUE 1 is fixed at track start). Preserve Serato saved loops; do not expose loop-slot editing. MP3/WAV/AIFF use the legacy `Markers_` frame and must leave existing ID3 `Markers2` unchanged. Waveforms cache under `<library>/.olooper-cache/waveforms/`.
- Never delete original SWF/EXE inputs or external custom-audio sources when removing library entries. Treat imported SWF/EXE/audio as untrusted: never execute projectors; retain parsing bounds/size checks, path sanitization, and validated/atomic writes.
- For non-trivial features, update/add a spec in `specs/`; record lasting architectural decisions in `docs/adr/`. Add regression coverage for parsing, persistence, serialization, or security-sensitive changes.
- `src-tauri/gen/` is generated and gitignored; `src-tauri/icons/` is committed and required to compile. Keep local data/artifacts such as `loopersFlash/`, `audios/`, `library/`, `.dev/`, `oLooper.app/`, and `dist/` out of commits.
