# 0008 — Background import worker with its own SQLite connection

## Context

`import_swf` held the shared `Db` mutex for the whole import, freezing library
reads and waveform peaks. The player already lived on its own thread, so only
the catalog side needed decoupling.

## Decision

- One `olooper-import` thread + `mpsc` job queue (Tauri state, wired in
  `setup()`). `import_swf` enqueues and returns `job_id` immediately.
- The worker opens its own `Library` connection per job; the final
  `ImportReport` travels in the `done` progress event (`report` field).
- `Library::open` sets `PRAGMA journal_mode=WAL` + `busy_timeout=5000` so the
  worker's writes don't lock out main-connection readers.
- Jobs run sequentially; no parallel decode in step 1.

## Consequences

- Playback, library browsing, and waveform stay responsive during imports.
- Two writers (worker imports, UI metadata edits) are serialized by SQLite;
  UI writes stay single-statement.
- `import_exe` / `import_custom` still synchronous; migrate them next using
  the same job shape. Revert is one commit (optional `report` event field).
