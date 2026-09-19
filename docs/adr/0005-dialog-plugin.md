# ADR 0005 — Native File Picker via tauri-plugin-dialog

- Status: accepted
- Date: 2026-09-19

## Context

The original UI required users to type or paste absolute file paths for
importing SWF/EXE/audio files and selecting the library root directory.
This is error-prone and unfamiliar to most users.

## Decision

- Use `tauri-plugin-dialog` (official Tauri 2 plugin) for native OS file
  and directory picker dialogs.
- Frontend accesses the plugin via `@tauri-apps/plugin-dialog` JS package.
- Dialog wrappers in `src/tauri.ts` (`pickFiles`, `pickDirectory`) provide
  typed interfaces for components.

## Capabilities

Added to `src-tauri/capabilities/default.json`:
- `dialog:allow-open` — enables `open()` for file/directory selection.
- `shell:allow-open` — enables "Show in Finder" via `Command.create("open", ["-R", path])`.

## Consequences

- Users get native macOS file pickers with standard UX (recent folders,
  column view, etc.).
- Path text inputs remain as fallback for power users.
- Import flow: Browse button → dialog → auto-import on selection.
- Library init flow: Folder icon → directory picker → path fills input.

## Alternatives considered

- **Path-only inputs (status quo)**: rejected — poor UX for non-technical
  users, no file type filtering.
- **Tauri FS plugin**: rejected — overkill; dialog plugin is sufficient.
- **Electron-style dialog**: not available in Tauri without plugin.
