# ADR 0028 — No-replace moves during recovery

- Status: accepted
- Date: 2026-10-29

## Context

Checking that a destination is absent before `rename` does not stop another
process from creating it between the check and the move. Quarantine rollback,
recovery and Windows Serato backup restoration must not overwrite that file.

## Decision

Use a no-replace filesystem operation for staging into quarantine, restoring
quarantined assets and moving/restoring Serato backups. On macOS/Linux/Android
use `rustix::fs::renameat_with` with `NOREPLACE`; on Windows use `MoveFileExW`
without replace or cross-volume-copy flags. Do not fall back to a destructive
ordinary rename if the operation is unsupported. Staged files and manifests
remain available for recovery when a destination conflict causes failure.

This does not make the entire metadata-write protocol immune to external
concurrent modifications. In particular, Unix Serato's final replacement is
still an intentional overwrite and log directory/rotation paths retain other
time-of-check/time-of-use windows. Those need separate platform-specific work.

## Consequences

- Filesystems lacking no-replace support return an error rather than risking a
  silent overwrite; source and destination must support a same-volume move.
- Tests cover ordinary destinations, dangling symlinks and actual library
  rollback on macOS. Windows's native behavior and filesystem-specific failure
  modes still require CI or native validation.
