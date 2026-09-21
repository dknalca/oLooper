# 095 — Background import worker

## Problem

`import_swf` / `import_exe` hold the shared `Db` mutex (`Mutex<Option<Library>>`,
`src-tauri/src/lib.rs`) for the whole import: decode every embedded sound +
BPM estimate each. A ~50-sound looper takes minutes. While held:

- `library_list`, favorites, metadata, slots all block → UI can't refresh.
- `player_waveform_peaks` blocks too (only needs the cache dir).
- The player itself is unaffected (own `olooper-audio` thread), but the app
  *feels* frozen: no library updates, no waveform, modal stuck on await.

## Goal (step 1: SWF only — DONE; step 2: EXE + custom — DONE)

Run SWF imports on a dedicated `olooper-import` thread with its own SQLite
connection, so playback + library browsing stay responsive. Step 2 extended
the same worker to `import_exe` (same job shape + offset/length) and
`import_custom` (per-file progress events, final `done` carries
`custom_report: CustomReport[]`).

## Design

- New Tauri state: job queue `mpsc::Sender<ImportJob>` + worker thread spawned
  once at startup (`run()`), named `olooper-import`.
- `ImportJob { root: PathBuf, path: String, job_id: String }`. The command
  resolves the library root from the shared `Library` (short lock), enqueues,
  returns `job_id: String` immediately. No `ImportReport` return anymore.
- Worker loop: `read_input` → `copy_dropped_source` → `parse` → open its own
  `Library::open(&root)` (migration is a no-op: main connection already
  migrated) → `import_sounds_with_progress` with per-sound progress events +
  `import_cancelled(job_id)` checks. Finish: emit `done` event **carrying the
  `ImportReport`**, or `failed` event with the error string.
- `ImportProgress` gains `report: Option<ImportReport>`. Event name unchanged
  (`olooper:import-progress`); old listeners ignore the new field.
- SQLite concurrency: `Library::open` sets `PRAGMA journal_mode=WAL` +
  `PRAGMA busy_timeout=5000`. Worker writes don't block main-connection
  readers. All UI-thread writes stay single-statement; no long transactions.
- Cancel: existing `CANCELLED_IMPORTS` set + `cancel_import` command, unchanged.
- Ordering: one worker thread = jobs run sequentially in enqueue order. No
  parallel decode in step 1 (responsiveness first, throughput later).

## Frontend contract (`src/tauri.ts`, sole bridge)

- `importSwf(path, jobId?): Promise<string>` — enqueue, resolves fast.
- `importSwfAndWait(path, jobId?): Promise<ImportReport>` — enqueue + resolve
  when the matching `done` event arrives; reject on `failed`/timeout. Keeps
  `ImportBar`'s `Promise<ImportReport>` call sites unchanged.
- `ImportProgress` gains `report: ImportReport | null`.
- `ImportBar`: use `importSwfAndWait` for `.swf` drops/browse. `onImported()`
  refresh still fires after each file (report-driven, same as today).

## Tests

- `Library::open` sets WAL: open temp root, `PRAGMA journal_mode` == `wal`.
- Two connections, one root: writer thread imports sounds while main handle
  calls `list_tracks()` concurrently; assert no `database is locked` errors.
- Cancel mid-job: enqueue, `cancel_import`, assert worker emits `failed` with
  "import cancelled" (unit-test the predicate path, not the Tauri event).
- Existing suite stays green: `cargo test` (79 passed baseline).

## Rollout / reversibility

- Step 1: WAL + worker + `import_swf` only. Step 2 (done): `import_exe` and
  `import_custom` on the worker; no synchronous import path remains.
- Revert: single commit restores sync commands; events keep working
  because `report` / `custom_report` are optional. Frontend `*AndWait`
  helpers degrade to a plain await with no behavior change.

## Non-goals

- Parallel decode within a job, waveform precompute during import, library
  repair, fingerprint duplicates — tracked separately.
