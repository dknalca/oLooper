# ADR 0003 — loopersFlash is a local dev inbox, never a build/CI input

- Status: accepted
- Date: 2026-09-18

## Context

Real-world `.swf`/`.exe` samples live in `loopersFlash/` (user-provided,
possibly copyrighted). CI must not depend on them.

## Decision

- `loopersFlash/` stays local and ignored by git.
- Automated tests use only synthetic/legal fixtures under `tests/fixtures/`.
- Real samples are validated manually via a local inventory script
  (sounds detected/extracted per file), never in CI.
- Tauri capabilities grant `loopersFlash/` read access in dev only;
  production uses file-picker/drag&drop + the library dir.

## Consequences

- Reproducible CI; no private files required to build or test.
- Manual validation step documented per extraction spec.
