# ADR 0022 — Bound transient audio work and serialize library mutations

- Status: accepted
- Date: 2026-10-25
- Supersedes ADR 0010's parallel preparation worker count.

## Context

The full-app audit found that limiting retained caches did not bound transient
PCM, parser and stretch allocations. Parallel sound preparation multiplied that
working set. Concurrent metadata writes could each read old tags and replace
another command's CUE update; filesystem quarantine also needed recovery after
an interrupted removal.

## Decision

- Prepare one import sound at a time, preserving source order and PCM reuse.
  Serialize expensive decode/container/stretch work with `memory::work_guard()`;
  retain parser, input, duration and PCM limits before allocation.
- Bound decoded and container caches by one eighth of available memory, capped
  respectively at 512 MiB / 32 tracks and 256 MiB / two sources. Share the memory
  sample for one second; use a conservative fallback and periodic trimming.
  Cache budgets are not a limit on total process memory.
- Look-ahead uses the existing decoded cache for sequential-next and random
  candidates. Keep one running prefetch and one waiting slot; do not start a new
  prefetch during an interactive decode. Library unload invalidates in-flight
  results. A running prefetch is not preempted by a later interactive load.
- Hold an exclusive file lease per library and serialize in-process mutations
  with a reentrant mutex across connections. Keep SQLite WAL and the busy timeout
  so readers and the import connection can coexist.
- Record removal quarantine in a durable, path-validated manifest and recover on
  library open. Stage and validate metadata replacements and recover supported
  orphaned backups before resolving missing managed files.

## Consequences

- Imports trade parallel throughput for a predictable transient working set.
  Interactive work may wait for an already-running guarded operation.
- Active playback buffers remain referenced even when cache entries are evicted;
  WebView, analysis and active buffers still require runtime memory measurements.
- Concurrent CUE writes preserve independent updates, and another process cannot
  mutate the same library while its lease is held.
- Regression checks cover budgets, stale results, IPC concurrency and recovery.
  Hardware, sustained-load and cross-platform runtime validation remain distinct
  release checks; see [validation evidence](../audit-validation-2026-10-25.md).
