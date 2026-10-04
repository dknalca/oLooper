# Agent Instructions

Tauri 2 desktop app: React/TypeScript frontend (`src/`) and Rust backend (`src-tauri/`); SQLite stores catalog metadata while audio remains ordinary files. Rust MSRV 1.87. No lint command is configured.

## Commands

- Use `pnpm` (lockfile is `pnpm-lock.yaml`). Dev: `pnpm install && pnpm tauri dev`; Vite requires fixed port `1420` (`vite.config.ts` / Tauri `devUrl`).
- Typecheck: `pnpm run typecheck`. Frontend tests: `pnpm test`; focused test: `pnpm vitest run src/importFlow.test.ts`.
- Rust tests: `cd src-tauri && cargo test`; focused test: `cargo test <name>` (add `-- --exact` for exact match).
- App build: `./scripts/build.sh [--dev]`. It installs frozen dependencies and generates required icons before invoking Tauri, then copies the app bundle to `./oLooper.app`; don't bypass it for local app builds. DMG: `./scripts/package-dmg.sh` after building (unsigned, macOS only).
- The ignored SWF regression test requires a real fixture: `OLOOPER_TURNTABLE_FIXTURE=/path/to/file.swf cargo test -- --ignored turntable_fixture` from `src-tauri/`. Real samples belong in gitignored `loopersFlash/`, never in commits.

## Architecture and constraints

- Backend commands and dialog wrappers belong in `src/tauri.ts`; components should not import Tauri APIs directly. The sole current exception is `getCurrentWebview` in `src/components/ImportBar.tsx` for drag/drop.
- Rust entrypoint/commands and app setup: `src-tauri/src/lib.rs`; audio engine: `player/`; import parsers: `import/`; library and all SQLite schema migrations: `library/mod.rs` (current schema v6; add migrations there); waveform and BPM analysis: `waveform.rs`, `analysis.rs`.
- Imports run on the `olooper-import` worker with its own SQLite connection. Commands enqueue and return; completion arrives via `olooper:import-progress` (final SWF/EXE `report`, custom-audio `custom_report`). `src/tauri.ts` `import*AndWait()` helpers subscribe and await completion. The library enables SQLite WAL and a busy timeout for worker/read concurrency.
- Keep extracted audio, copied SWF/EXE sources, SQLite, and derived caches under the user-selected library root. SQLite is the catalog/source of truth for track catalog fields; four CUEs are read/written in managed audio tags, with CUE 1 fixed at track start. Preserve Serato saved loops without exposing loop-slot editing in oLooper. MP3/WAV/AIFF use the legacy `Markers_` frame and leave existing ID3 `Markers2` unchanged. First launch suggests `~/Documents/oLooper_data`; the chosen root is remembered in application preferences, never in a loose file beside the app. Removing tracks/groups deletes only library-managed audio/cover copies; never delete original SWF/EXE or external custom-audio sources. Waveform cache lives at `<library>/.olooper-cache/waveforms/`.
- Treat SWF, EXE and audio inputs as untrusted data; never execute projectors. Preserve source files and retain bounds/size checks, path sanitization, and validated/atomic writes in import/storage paths.
- For non-trivial features, update/add a spec in `specs/`; record lasting architectural decisions in `docs/adr/`. Add regression coverage for parsing, persistence, serialization, or security-sensitive changes.
- `src-tauri/gen/` is generated and gitignored; `src-tauri/icons/` is committed and required to compile. Keep local samples/data and artifacts (`loopersFlash/`, `audios/`, `library/`, `olooper-library.json`, `.dev/`, `oLooper.app/`, `dist/`) out of commits.
