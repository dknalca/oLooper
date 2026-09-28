# 095 — Background import worker

## Problem

Before the worker existed, `import_swf` / `import_exe` held the shared `Db`
mutex (`Mutex<Option<Library>>`, `src-tauri/src/lib.rs`) throughout audio decode
and BPM analysis.

While the lock was held:
- `library_list`, favorites, metadata, slots all block → UI can't refresh.
- `player_waveform_peaks` blocks too (only needs the cache dir).
- The `olooper-audio` thread was unaffected, but the UI stalled while library
  and waveform requests waited on the lock.

## Design

- A single `olooper-import` worker and `mpsc` queue handle SWF, EXE, custom
  audio, and Tablist jobs. Commands resolve the library root under a short lock,
  enqueue, and return a job ID.
- `ImportJob` carries the root, kind, paths, optional cover path, and job ID.
  The worker opens its own `Library` connection for each job.
- Jobs run in enqueue order. Within SWF/EXE jobs, audio decode and BPM analysis
  run in batches of up to four threads; filesystem writes and SQLite updates
  remain serial and preserve source order (ADR 0010).
- Each sound is decoded once; the PCM buffer is reused for MP3 trimming and BPM
  analysis.
- Progress is emitted on `olooper:import-progress`. Final events carry an
  `ImportReport` or per-file `custom_report` as appropriate.
- SQLite concurrency: `Library::open` sets `PRAGMA journal_mode=WAL` +
  `PRAGMA busy_timeout=5000`. Worker writes don't block main-connection
  readers. All UI-thread writes stay single-statement; no long transactions.
- Cancellation uses the `cancel_import` command and is checked between import
  units; completed tracks remain in the library.

## Frontend contract (`src/tauri.ts`, sole bridge)

- `importSwfAndWait`, `importExeAndWait`, `importCustomAndWait`, and
  `importTablistAndWait` subscribe to progress and resolve with the matching
  final report. The bridge is defined in `src/tauri.ts`.
- `ImportProgress` carries optional final `report` and `custom_report` fields.

## Tests

- `Library::open` sets WAL: open temp root, `PRAGMA journal_mode` == `wal`.
- Two connections, one root: writer thread imports sounds while main handle
  calls `list_tracks()` concurrently; assert no `database is locked` errors.
- Synthetic multi-sound import verifies bounded-parallel preparation still
  stores tracks and report IDs in source order.

## Non-goals

- Waveform precompute during import, library repair, fingerprint duplicates —
  tracked separately.
