# 0008 — Background import worker with its own SQLite connection

## Context

`import_swf` held the shared `Db` mutex for the whole import, freezing library
reads and waveform peaks. The player already lived on its own thread, so only
the catalog side needed decoupling.

## Decision

- One `olooper-import` thread + `mpsc` job queue handles SWF, EXE, custom-audio,
  and Tablist jobs. Import commands enqueue and return a `job_id` immediately.
- The worker opens its own `Library` connection per job; final reports travel
  in the `done` progress event.
- `Library::open` sets `PRAGMA journal_mode=WAL` + `busy_timeout=5000` so the
  worker's writes don't lock out main-connection readers.
- Jobs run sequentially in queue order. SWF/EXE audio preparation uses bounded
  parallel batches while filesystem and database writes stay ordered (ADR 0010).

## Consequences

- Playback, library browsing, and waveform stay responsive during imports.
- Two writers (worker imports, UI metadata edits) are serialized by SQLite;
  UI writes stay single-statement.
- Playback, library browsing, and waveform work remain responsive during imports.
