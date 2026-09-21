# Agent Instructions

Tauri 2 desktop app: React 18 + TS (strict) + Tailwind v4 + Vite 6 frontend, Rust core (edition 2021, MSRV 1.87), SQLite catalog (schema v6). Extracts practice loops from legacy Flash `.swf` / projector `.exe` files.

## Commands (use pnpm, not npm)

- Dev: `pnpm install && pnpm tauri dev` (fixed port `1420`, must match `devUrl` in `src-tauri/tauri.conf.json`).
- Build: `./scripts/build.sh` (`--dev` for faster debug build). Do NOT run `pnpm run tauri build` directly — `build.sh` first runs `pnpm install --frozen-lockfile` + `node scripts/generate-icons.mjs` (compile needs `src-tauri/icons/icon.icns|.png`) and copies the `.app` to repo root via `ditto`.
- DMG: `./scripts/package-dmg.sh` (unsigned).
- Typecheck: `pnpm run typecheck`. No lint configured. No CI workflows.

## Tests

- Rust: `cargo test` from `src-tauri/`; single test: `cargo test <name> -- --exact` (or partial match without `--exact`).
- `#[ignore]` Rust tests need real fixtures in `loopersFlash/` (gitignored, never commit, never CI): `cargo test -- --ignored`.
- Frontend (Vitest): `pnpm test`; single file: `pnpm vitest run src/importFlow.test.ts`.

## Architecture

- `src/tauri.ts` is the only typed bridge to backend commands. Components must not import `@tauri-apps/api/*` directly — sole exception: `getCurrentWebview` from `@tauri-apps/api/webview` in `ImportBar.tsx` for drag-drop. File-picker `open()` from `@tauri-apps/plugin-dialog` lives in `tauri.ts` wrappers (`pickFiles`, `pickDirectory`).
- Rust: `src-tauri/src/lib.rs` (commands + portable-storage app builder), `player/mod.rs` (rodio engine), `library/mod.rs` (all SQLite migrations via `PRAGMA user_version`; current v6 — add new migrations there), `import/` (SWF/EXE parsers), `waveform.rs`, `analysis.rs` (BPM).
- Library model: audio stays as normal files under a configurable root; SQLite holds catalog + derived metadata only. Default root is portable (beside the app); custom root persisted via `library_init`/`library_restore`. Waveform cache: `<library>/.olooper-cache/waveforms/`. Removing a track/group never deletes source audio from disk.
- Imports: SQLite runs in WAL mode (`Library::open` sets `journal_mode=WAL` + `busy_timeout`). `import_swf`/`import_exe`/`import_custom` only enqueue on the `olooper-import` worker thread (own DB connection) and return `job_id` immediately; the result arrives in the `done` `olooper:import-progress` event (`report` field, or `custom_report` for custom audio). Frontend: `import*()` enqueue, `import*AndWait()` await the result.
- Serato is an export adapter only, never the internal model.

## Safety (untrusted input)

- Parse `.swf`/`.exe`/audio as data only — never execute. Preserve source files; use bounds checks, allocation limits, sanitized paths, atomic/validated writes for extracted audio and metadata.
- Don't claim third-party metadata compatibility without fixture tests against real-world versions.

## Conventions

- Styling: Tailwind utilities only, no `style={}` props; tokens in `src/index.css` (`--color-*`).
- Keyboard shortcuts live in `src/hooks/useKeyboardShortcuts.ts`; disabled while typing.
- `src-tauri/gen/` is gitignored but `src-tauri/icons/` IS committed (required at compile time).
- Never commit: `loopersFlash/`, `audios/`, `olooper-library.json`, `.dev/` (scratch verification artifacts go here), `oLooper.app/`, `dist/`.
- Non-trivial work: update/add spec in `specs/` first, record lasting decisions in `docs/adr/`. Keep changes small and reversible; add regression tests for parsing, serialization, persistence, and security-sensitive paths. If a change affects user data, format compat, or irreversible behavior, ask or pick a safe reversible path and document it.
