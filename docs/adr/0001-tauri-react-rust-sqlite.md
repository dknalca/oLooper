# ADR 0001 — Tauri 2 + React/TypeScript + Rust + SQLite

- Status: accepted
- Date: 2026-09-18

## Context

Need a cross-platform desktop shell (macOS 12 first) with a modern UI,
a native core for binary parsing/filesystem/audio, and a local metadata store.

## Decision

- Shell: Tauri 2. Frontend: React + strict TypeScript (Vite).
- Core: Rust. Metadata: SQLite with explicit migrations.
- All parsing, filesystem mutation, audio, persistence, and serialization
  live behind typed Tauri commands. React holds no business-critical logic.

## Consequences

- End-user builds are self-contained; dev needs Rust + Node only.
- Frontend/backend contract is typed DTOs; breaking changes update spec + tests.
