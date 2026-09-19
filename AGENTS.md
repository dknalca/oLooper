# Agent Instructions

## Repository status

- This repository contains a working Tauri 2 desktop application with React/TypeScript frontend and Rust core.
- Build: `pnpm install && pnpm run tauri build` (or `./scripts/build.sh`).
- Typecheck: `pnpm run typecheck`. Lint: not yet configured.
- Tests: Rust unit tests via `cargo test` in `src-tauri/`. Frontend tests via `pnpm test` (Vitest).

## Tech stack

- **Frontend**: React 18, TypeScript (strict), Tailwind CSS v4, Vite 6.
- **Backend**: Rust, Tauri 2, rodio (audio), rusqlite (bundled SQLite), sha2, flate2.
- **Plugins**: `tauri-plugin-dialog` (file pickers), `tauri-plugin-shell` (Show in Finder).
- **Icons**: Generated via `scripts/generate-icons.mjs` (sharp + SVG source in `.dev/icon-source.svg`).
- **Frontend tests**: Vitest (configured in `package.json`, run via `pnpm test`).

## Product boundaries

- The app is a cross-platform Tauri 2 desktop app with a React/TypeScript frontend, Rust core, and SQLite metadata store.
- Keep binary parsing, filesystem mutation, audio analysis, persistence, and metadata serialization out of React components; expose them through typed Tauri commands.
- User audio must remain normal files in a configurable library. SQLite stores catalog and derived metadata, not the only copy of audio.
- Serato is an adapter/export target, not the internal track model or source of truth.

## Safety requirements

- Treat imported `.swf`, `.exe`, and audio files as untrusted input. Parse them as data; never execute imported executables or Flash content.
- Preserve source files. Use bounds checks, allocation limits, sanitized paths, and atomic/validated writes for extracted audio and metadata.
- Do not claim third-party metadata compatibility without fixture tests and validation against supported real-world versions.

## Change workflow

- For non-trivial work, update or add the relevant specification under `specs/` before implementation. Record lasting architecture decisions under `docs/adr/`.
- Define observable acceptance criteria, failure behavior, persistence behavior, platform implications, security implications, and non-goals.
- Keep changes small and reversible. Add regression tests for parsing, serialization, persistence, and security-sensitive behavior when test infrastructure exists.
- If requirements affect user data, file-format compatibility, irreversible behavior, architecture, security, or licensing, do not silently guess; ask or choose a safe reversible/unsupported path and document it.

## Dev conventions

- All frontend styling uses Tailwind utility classes. No inline `style={}` props.
- Design tokens in `src/index.css` (`--color-*` variables).
- All Tauri command wrappers in `src/tauri.ts`. Components must not import `@tauri-apps/api` directly (except `@tauri-apps/api/webview` for drag-drop and `@tauri-apps/plugin-dialog` for file pickers).
- Keyboard shortcuts in `src/hooks/useKeyboardShortcuts.ts`.
- Scratch verification artifacts go in `.dev/` (gitignored).
- Real samples in `loopersFlash/` (gitignored, never in CI).
