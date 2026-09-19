# Agent Instructions

## Repository status

- This repository currently contains project guidance only; no source tree, manifests, CI, or test configuration is present.
- Do not invent build, test, lint, or formatting commands. Re-check the root when implementation files are added.

## Product boundaries

- The planned app is a cross-platform Tauri 2 desktop app with a React/TypeScript frontend, Rust core, and SQLite metadata store.
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
